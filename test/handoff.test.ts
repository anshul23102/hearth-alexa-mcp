import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.js";
import { ingestOrders } from "../src/ingest.js";
import { forecast } from "../src/forecast.js";
import { amazonCartStore, confirm, propose, simulatedStore, storeFromEnv, undo } from "../src/actions.js";
import { link, startServer } from "./helpers.js";

// Where does an order go? In the demo, nowhere: a simulated store. The one real-world connector that needs no credentials prepares the
// person's Amazon cart with Amazon's documented "Add to Cart" link and lets Amazon's own checkout take the order. These tests pin what
// that connector may and may not do.
const CSV = readFileSync("data/sample-orders.csv", "utf8");
const line = (productKey: string, packs: number, currency = "USD") => ({ productKey, title: "t", name: "n", packs, unitPriceCents: 100, currency, reason: "" });

test("the cart link carries the ASINs and quantities, on the storefront that matches the household's currency", async () => {
  const store = amazonCartStore({});
  const us = await store.place([line("asin:B000ABCDE1", 2), line("asin:B000ABCDE2", 1)], "abcdef1234567890");
  assert.equal(us.handoffUrl, "https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B000ABCDE1&Quantity.1=2&ASIN.2=B000ABCDE2&Quantity.2=1");
  assert.equal(us.orderRef, "CART-ABCDEF12");
  assert.match((await store.place([line("asin:B000ABCDE1", 1, "INR")], "k")).handoffUrl!, /^https:\/\/www\.amazon\.in\//);
  assert.match((await store.place([line("asin:B000ABCDE1", 1, "GBP")], "k")).handoffUrl!, /^https:\/\/www\.amazon\.co\.uk\//);
});

test("only well-formed ASINs go in the cart, quantities are bounded, and nothing else can reach the URL", async () => {
  const store = amazonCartStore({});
  const r = await store.place([line("asin:B000ABCDE1", 500), line("title:some product", 1), line("asin:b000abcde2", 1), line("asin:B0&evil=1x", 1), line("asin:<script>aa", 1)], "k");
  assert.equal(r.handoffUrl, "https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B000ABCDE1&Quantity.1=99", "titles, lowercase and hostile keys are left out; 500 packs becomes 99");
  await assert.rejects(store.place([line("title:no asin here", 1)], "k"), /ASIN/);
  await assert.rejects(amazonCartStore({ HEARTH_AMAZON_HOST: "www.amazon.com.evil.example" }).place([line("asin:B000ABCDE1", 1)], "k"), /Amazon storefront/);
  await assert.rejects(amazonCartStore({ HEARTH_AMAZON_HOST: "evil.example" }).place([line("asin:B000ABCDE1", 1)], "k"), /Amazon storefront/);
});

test("approving prepares the cart, a retry gives the same link, and there is nothing to undo because nothing was ordered", async () => {
  const db = openDb(":memory:");
  ingestOrders(db, "h", CSV);
  const store = amazonCartStore({});
  const plan = propose(db, "h", forecast(db, "h"), { withinDays: 30, budgetCents: 6000 });
  const a = await confirm(db, store, "h", plan.id, "app");
  assert.equal(a.ok, true);
  const url = (a as any).receipt.handoffUrl as string;
  assert.match(url, /^https:\/\/www\.amazon\.com\/gp\/aws\/cart\/add\.html\?ASIN\.1=/);
  const again = await confirm(db, store, "h", plan.id, "app");
  assert.equal((again as any).receipt.handoffUrl, url);
  const u = await undo(db, store, "h", plan.id);
  assert.equal(u.ok, false);
  assert.match(u.message, /Nothing was ordered/);
});

test("the default store stays the simulated one, and the demo is unchanged", () => {
  assert.equal(storeFromEnv({}), simulatedStore);
  assert.notEqual(storeFromEnv({ HEARTH_STORE: "amazon-cart" }), simulatedStore);
});

test("a card may open the prepared cart and the regulators' notices, and nothing else", async () => {
  const { OPEN_OK } = (await import("../web/appHost.js" as string)) as { OPEN_OK: RegExp };
  assert.ok(OPEN_OK.test("https://www.amazon.in/gp/aws/cart/add.html?ASIN.1=B000ABCDE1&Quantity.1=2"));
  assert.ok(OPEN_OK.test("https://www.cpsc.gov/Recalls/2025/x"));
  for (const bad of ["https://www.amazon.com.evil.example/gp/aws/cart/add.html?ASIN.1=B000ABCDE1", "https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=<script>", "https://www.amazon.com/dp/B000ABCDE1", "https://evil.example/https://www.amazon.com/gp/aws/cart/add.html?a=b", "javascript:alert(1)", "http://www.amazon.com/gp/aws/cart/add.html?a=b"]) assert.equal(OPEN_OK.test(bad), false, bad);
});

test("a live server in cart mode: approving says the cart is ready, and undo explains there is nothing to cancel", async () => {
  const { proc, base } = await startServer(3998, { HEARTH_STORE: "amazon-cart" });
  try {
    const tok = await link(base);
    const c = new Client({ name: "handoff", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
    await c.callTool({ name: "import_order_history", arguments: { csv: CSV } });
    const plan = (await c.callTool({ name: "plan_restock", arguments: { withinDays: 30, budget: 80 } })) as any;
    const id = plan.structuredContent.proposal.id as string;
    const done = (await c.callTool({ name: "approve_restock", arguments: { proposalId: id } })) as any;
    assert.match(done.content[0].text, /Your Amazon cart is ready with \d+ items/);
    assert.match(done.structuredContent.receipt.handoffUrl, /^https:\/\/www\.amazon\.com\/gp\/aws\/cart\/add\.html\?ASIN\.1=/);
    assert.ok(!/undo_restock/.test(JSON.stringify(done.content)), "the model is not told to offer an undo for a cart");
    const u = (await c.callTool({ name: "undo_restock", arguments: { proposalId: id } })) as any;
    assert.equal(u.isError, true);
    assert.match(u.content[0].text, /Nothing was ordered/);
    await c.close();
  } finally { proc.kill(); }
});

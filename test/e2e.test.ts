import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { approve, consentNonce, link, pkce, register, startServer } from "./helpers.js";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 3951;
const BASE = `http://localhost:${PORT}`;
let proc: ChildProcess;
let client: Client;

before(async () => {
  ({ proc } = await startServer(PORT));
  // The wrong PKCE verifier must be refused (and burns the code).
  const redirect = "http://localhost/cb";
  const cid = await register(BASE, redirect);
  const { verifier, challenge } = pkce();
  const code = new URL((await approve(BASE, await consentNonce(BASE, cid, challenge, redirect))).headers.get("location")!).searchParams.get("code")!;
  const bad = await fetch(`${BASE}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: cid, redirect_uri: redirect, code_verifier: "w".repeat(43) }) });
  assert.equal(bad.status, 400, "wrong PKCE verifier must fail");
  const tok = await link(BASE);
  client = new Client({ name: "e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
});
after(async () => { await client?.close(); proc?.kill(); });

const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const sc = (r: unknown) => (r as { structuredContent: any }).structuredContent;
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

test("rejects unauthenticated clients with discovery header", async () => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata=/);
});

test("negotiates the 2025-11-25 protocol and lists tools with annotations", async () => {
  assert.equal(client.getServerVersion()?.name, "hearth");
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["activity_log", "approval_code", "approve_restock", "check_recalls", "confirm_restock", "delete_household_data", "household_runway", "import_order_history", "plan_restock", "recall_alerts", "recall_status", "remember_preference", "undo_restock"]);
  assert.equal(tools.find((t) => t.name === "confirm_restock")!.annotations?.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === "household_runway")!.annotations?.readOnlyHint, true);
  const appCallable = tools.filter((t) => ((t._meta as any)?.ui?.visibility ?? ["model", "app"]).includes("app")).map((t) => t.name).sort();
  assert.deepEqual(appCallable, ["approval_code", "approve_restock", "delete_household_data", "plan_restock", "recall_status", "remember_preference", "undo_restock"], "cards may only call the approval-gated tools, the recall progress buttons, the skip switch and the budget slider (planning buys nothing)");
  const modelCallable = tools.filter((t) => ((t._meta as any)?.ui?.visibility ?? ["model", "app"]).includes("model")).map((t) => t.name);
  for (const t of ["delete_household_data", "approve_restock", "approval_code"]) assert.ok(!modelCallable.includes(t), `the model must never be offered ${t}`);
  assert.ok(modelCallable.includes("confirm_restock"), "the model's only route to ordering is the code-gated tool");
  const { APP_ONLY_TOOLS } = await import("../src/server.js");
  assert.deepEqual([...APP_ONLY_TOOLS].sort(), tools.filter((t) => ((t._meta as any)?.ui?.visibility ?? []).join() === "app").map((t) => t.name).sort(), "the server-side strip list matches the tools marked app-only");
  const res = await client.listResources();
  assert.ok(res.resources.some((r) => r.uri === "ui://hearth/runway"));
});

test("empty household is handled gracefully", async () => {
  const r = await call("household_runway");
  assert.match(text(r), /enough order history/);
});

test("import cleans a messy export and is idempotent", async () => {
  const csv = readFileSync("data/sample-orders.csv", "utf8");
  const a = sc(await call("import_order_history", { csv }));
  assert.ok(a.imported > 150, `imported ${a.imported}`);
  assert.ok(a.duplicates >= 1 && a.skipped.length >= 1 && a.repaired.length >= 1);
  const b = sc(await call("import_order_history", { csv }));
  assert.equal(b.imported, 0, "re-import must add nothing");
});

test("forecast merges retitled listings and reports confidence", async () => {
  const s = sc(await call("household_runway", { withinDays: 60 }));
  assert.equal(s.items.length, 9);
  assert.ok(s.items.every((i: any) => i.productKey.startsWith("asin:")));
  assert.ok(s.items.filter((i: any) => i.confidence === "high").length >= 7);
  assert.ok(s.items.every((i: any, idx: number, arr: any[]) => idx === 0 || arr[idx - 1].daysLeft <= i.daysLeft), "sorted by urgency");
});

test("recall check finds the real SharkNinja Foodi recall with evidence", async () => {
  const s = sc(await call("check_recalls"));
  const m = s.matches.find((x: any) => /Foodi/i.test(x.owned.title));
  assert.ok(m, "expected a Ninja Foodi match");
  assert.equal(m.level, "likely");
  assert.ok(m.evidence.some((e: string) => /OP302/.test(e)));
  assert.match(m.recall.url, /^https:\/\/www\.cpsc\.gov\//);
  assert.ok(!s.matches.some((x: any) => /Dyson|Sonicare/i.test(x.owned.title)), "no false positives");
});

test("plan respects budget, refuses unconfirmed orders, is idempotent, and undoes", async () => {
  await call("remember_preference", { kind: "budget_usd", value: "60" });
  const plan = sc(await call("plan_restock", { withinDays: 21 })).proposal;
  assert.ok(plan.lines.length > 0 && plan.totalCents <= 6000, `total ${plan.totalCents}`);
  assert.ok(plan.dropped.length > 0, "budget should have dropped something");

  const refused = await call("confirm_restock", { proposalId: plan.id });
  assert.equal((refused as any).isError, true, "no code, no order");

  const code = sc(await call("approval_code", { proposalId: plan.id })).code as string; // what the card shows the person
  const ok = sc(await call("confirm_restock", { proposalId: plan.id, approvalCode: code }));
  assert.match(ok.receipt.orderRef, /^SIM-/);
  const again = sc(await call("confirm_restock", { proposalId: plan.id, approvalCode: code }));
  assert.equal(again.replayed, true);
  assert.equal(again.receipt.orderRef, ok.receipt.orderRef, "retry must not create a second order");

  const u = await call("undo_restock", { proposalId: plan.id });
  assert.notEqual((u as any).isError, true);
  const u2 = await call("undo_restock", { proposalId: plan.id });
  assert.equal((u2 as any).isError, true, "cannot undo twice");

  const log = sc(await call("activity_log", { limit: 20 })).items.map((i: any) => i.action);
  for (const a of ["import_orders", "check_recalls", "propose_restock", "confirm_restock", "undo_restock"]) assert.ok(log.includes(a), a);
});

test("unknown proposals and bad inputs fail cleanly", async () => {
  const r = await call("confirm_restock", { proposalId: "prop_nope", approvalCode: "0000" });
  assert.equal((r as any).isError, true);
  const v = await call("plan_restock", { withinDays: 9999 });
  assert.equal((v as any).isError, true, "schema violations come back as tool errors the model can read");
  const b = await call("remember_preference", { kind: "budget_usd", value: "-5" });
  assert.equal((b as any).isError, true);
});

test("asks for approval through MCP elicitation when the client supports it", async () => {
  // Second client that declares elicitation and approves/declines on demand.
  const { ElicitRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const form = async (c: Client) => { const p = sc(await c.callTool({ name: "plan_restock", arguments: { withinDays: 21, budgetUsd: 40 } })).proposal; return p.id as string; };
  const token = (client as any)._transport?._requestInit?.headers?.authorization as string;
  assert.ok(token);
  let answer: "accept" | "decline" = "decline";
  const c2 = new Client({ name: "elicit", version: "1" }, { capabilities: { elicitation: {} } });
  c2.setRequestHandler(ElicitRequestSchema, async () => answer === "accept" ? { action: "accept", content: { approve: true } } : { action: "decline" });
  await c2.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: token } } }));
  const id = await form(c2);
  const declined = sc(await c2.callTool({ name: "confirm_restock", arguments: { proposalId: id } }));
  assert.equal(declined.declined, true, "declining the elicitation must not place the order");
  answer = "accept";
  const placed = sc(await c2.callTool({ name: "confirm_restock", arguments: { proposalId: id } }));
  assert.match(placed.receipt.orderRef, /^SIM-/);
  await c2.close();
});

test("the skip switch on a forecast row is reversible and really changes the plan", async () => {
  const before = sc(await call("household_runway", { withinDays: 60 }));
  const target = before.items[0];
  assert.equal(target.skipped, false);
  await call("remember_preference", { kind: "skip_item", value: target.productKey });
  const during = sc(await call("household_runway", { withinDays: 60 }));
  assert.equal(during.items.find((i: any) => i.productKey === target.productKey).skipped, true, "the row shows it is switched off");
  const planned = sc(await call("plan_restock", { withinDays: 60 })).proposal;
  assert.ok(!planned.lines.some((l: any) => l.productKey === target.productKey), "a skipped item is left out of plans");
  await call("remember_preference", { kind: "unskip_item", value: target.productKey });
  assert.equal(sc(await call("household_runway", { withinDays: 60 })).items.find((i: any) => i.productKey === target.productKey).skipped, false, "resuming puts it back");
  assert.equal(((await call("remember_preference", { kind: "unskip_item", value: "bad key!" })) as any).isError, true, "keys are validated");
});

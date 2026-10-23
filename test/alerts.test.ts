import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../src/db.js";
import { ingestOrders } from "../src/ingest.js";
import { processNewRecalls, listAlerts, markAlertsSeen, countNewAlerts } from "../src/alerts.js";
import { storeRecalls, syncRecalls, type Provider, type RecallRecord } from "../src/recallIndex.js";
import { link, startServer } from "./helpers.js";

const CSV = readFileSync("data/sample-orders.csv", "utf8");
const rec = (id: string, title: string, text = title, date = "2026-10-20"): RecallRecord => ({ source: "cpsc", extId: id, region: "US", date, title, product: "", text, url: "https://www.cpsc.gov/x", hazard: "Burn hazard", remedy: "Stop using it" });
const FOODI = rec("900", "SharkNinja Recalls Foodi Multi-Function Pressure Cookers Due to Burn Hazard", "Foodi pressure cookers models OP300 OP301 OP302");

test("a new recall finds its owners by brand, scores them, and is idempotent", () => {
  const db = openDb(":memory:");
  ingestOrders(db, "owner", CSV);                       // owns Ninja Foodi OP302, Cuisinart blender, Dyson, Sonicare
  ingestOrders(db, "other", CSV.split("\n").filter((l, i) => i === 0 || !/Ninja/.test(l)).join("\n")); // no Ninja
  const r1 = processNewRecalls(db, [FOODI]);
  assert.equal(r1.created, 1);
  assert.deepEqual([...r1.households], ["owner"]);
  const a = listAlerts(db, "owner", { onlyNew: true });
  assert.equal(a.length, 1);
  assert.equal(a[0].match.level, "likely");
  assert.ok(a[0].match.evidence.some((e) => /OP302/.test(e)));
  assert.equal(listAlerts(db, "other").length, 0, "households without the brand are untouched");
  assert.equal(processNewRecalls(db, [FOODI]).created, 0, "replaying the same notice never duplicates alerts");
  assert.equal(countNewAlerts(db, "owner"), 1);
  assert.equal(markAlertsSeen(db, "owner", [a[0].id]), 1);
  assert.equal(countNewAlerts(db, "owner"), 0);
  assert.equal(markAlertsSeen(db, "other", [a[0].id]), 0, "a household cannot touch another's alerts");
});

test("accessory recalls, returned items and unrelated brands raise no alert", () => {
  const db = openDb(":memory:");
  ingestOrders(db, "h", CSV);
  const part = rec("901", "FirstPower Replacement Battery for Dyson V6 Vacuums recalled due to fire hazard");
  const other = rec("902", "Acme Kettle recalled due to burn hazard");
  assert.equal(processNewRecalls(db, [part, other]).created, 0);
  db.prepare("UPDATE orders SET status = 'returned' WHERE title LIKE '%Ninja%'").run();
  assert.equal(processNewRecalls(db, [FOODI]).created, 0, "a product you returned is not yours to be warned about");
});

test("only genuinely new notices are reported by a sync, and never on the first sync", async () => {
  const db = openDb(":memory:");
  let feed = [rec("1", "Acme Kettle recalled"), rec("2", "Beta Fan recalled")];
  const p: Provider = { source: "cpsc", region: "US", fetchLive: async () => feed, fromFixture: () => [] };
  const first = await syncRecalls(db, { providers: [p], offline: false });
  assert.equal(first[0].fresh.length, 0, "history is not 'new'");
  feed = [...feed, rec("3", "Gamma Heater recalled")];
  const second = await syncRecalls(db, { providers: [p], offline: false, force: true });
  assert.deepEqual(second[0].fresh.map((r) => r.extId), ["3"]);
  assert.deepEqual(storeRecalls(db, "cpsc", feed), [], "re-storing the same set reports nothing new");
});

test("alert matching stays fast at scale: 5,000 households, one new recall", () => {
  const db = openDb(":memory:");
  db.exec("BEGIN");
  const ins = db.prepare("INSERT INTO orders (household, order_id, ordered_at, title, qty, pack_units, unit_price_cents, currency, status, product_key, kind, brand, dedupe) VALUES (?, ?, ?, ?, 1, 1, 9900, 'USD', 'delivered', ?, 'durable', ?, ?)");
  const items = [["Ninja Foodi 6.5 Qt Pressure Cooker OP302", "ninja"], ["Dyson V8 Cordless Vacuum", "dyson"], ["Cuisinart Compact Blender & Juice Extractor", "cuisinart"], ["Philips Sonicare 4100", "philips"]];
  for (let h = 0; h < 5000; h++) { const [t, b] = items[h % items.length]; ins.run(`hh${h}`, `o${h}`, "2025-01-01", t, `k${h % 4}`, b, `d${h}`); }
  db.exec("COMMIT");
  const t0 = performance.now();
  const r = processNewRecalls(db, [FOODI]);
  const ms = performance.now() - t0;
  assert.equal(r.created, 1250);
  assert.ok(ms < 1500, `owner lookup took ${ms.toFixed(0)} ms`);
});

// ---- end to end: operator replays a real notice, the open session is pushed to over MCP -----------------

let proc: ChildProcess, BASE = "";
const ADMIN = "a".repeat(32);
before(async () => { ({ proc, base: BASE } = await startServer(3971, { HEARTH_ADMIN_TOKEN: ADMIN })); });
after(() => { proc?.kill(); });
const sc = (r: unknown) => (r as { structuredContent: any }).structuredContent;

test("push: a subscribed session is notified when an owned product is recalled, others are not", async () => {
  const [a, b] = [await link(BASE), await link(BASE)];
  const mk = async (tok: { access_token: string }) => {
    const c = new Client({ name: "push", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
    return c;
  };
  const [ca, cb] = [await mk(a), await mk(b)];
  assert.ok(ca.getServerCapabilities()?.resources?.subscribe, "server advertises resource subscriptions");
  await ca.callTool({ name: "import_order_history", arguments: { csv: CSV } });
  await cb.callTool({ name: "import_order_history", arguments: { csv: CSV.split("\n").filter((l, i) => i === 0 || !/Ninja/.test(l)).join("\n") } });
  await ca.callTool({ name: "check_recalls", arguments: {} }); // makes sure the (offline fixture) index is loaded
  const got: string[] = [], gotB: string[] = [];
  ca.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => { got.push(n.params.uri); });
  cb.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => { gotB.push(n.params.uri); });
  await ca.subscribeResource({ uri: "hearth://alerts" });
  await cb.subscribeResource({ uri: "hearth://alerts" });
  assert.equal(sc(await ca.callTool({ name: "recall_alerts", arguments: {} })).matches.length, 0, "nothing yet");

  const call = (token?: string) => fetch(`${BASE}/api/admin/recalls/replay`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify({ source: "cpsc", titleContains: "Foodi" }) });
  assert.equal((await call()).status, 401);
  assert.equal((await call("wrong".repeat(8))).status, 401);
  const res = await call(ADMIN);
  assert.equal(res.status, 200);
  const out = (await res.json()) as { alerts: number; households: number; notifiedSessions: number };
  assert.equal(out.alerts, 1);
  assert.equal(out.notifiedSessions, 1, "exactly the owner's open session was pushed to");
  for (let i = 0; i < 40 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got, ["hearth://alerts"]);
  assert.deepEqual(gotB, [], "a household that does not own the product hears nothing");

  const alerts = sc(await ca.callTool({ name: "recall_alerts", arguments: {} }));
  assert.equal(alerts.matches.length, 1);
  assert.equal(alerts.matches[0].level, "likely");
  const again = sc(await ca.callTool({ name: "recall_alerts", arguments: {} }));
  assert.equal(again.matches.length, 0, "seen alerts are not repeated");
  assert.equal(sc(await cb.callTool({ name: "recall_alerts", arguments: { includeSeen: true } })).matches.length, 0);
  const res2 = JSON.parse(((await ca.readResource({ uri: "hearth://alerts" })).contents[0] as { text: string }).text);
  assert.equal(res2.new, 0);

  // Reminders: still open, so it comes back as a new alert and the open session is told again.
  const remind = (token?: string, afterHours = 0) => fetch(`${BASE}/api/admin/reminders/run`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify({ afterHours }) });
  assert.equal((await remind()).status, 401, "operator only");
  const before = got.length;
  const reminded = (await (await remind(ADMIN)).json()) as { households: number; notifiedSessions: number };
  assert.deepEqual(reminded, { households: 1, notifiedSessions: 1 });
  for (let i = 0; i < 40 && got.length === before; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(got.length, before + 1, "the reminder is pushed like any alert");
  const back = await ca.callTool({ name: "recall_alerts", arguments: {} });
  assert.equal(sc(back).matches[0].reminder, 1);
  assert.match((back as any).content[0].text, /^Reminder: /, "the spoken line says it is a reminder");
  const m = sc(back).matches[0];
  await ca.callTool({ name: "recall_status", arguments: { recallId: m.recall.id, productKey: m.owned.productKey, status: "resolved" } });
  assert.deepEqual(await (await remind(ADMIN)).json(), { households: 0, notifiedSessions: 0 }, "a resolved recall is never reminded");
  await ca.close(); await cb.close();
});

test("the admin endpoint is off without a token and never reveals itself", async () => {
  const { proc: p2, base } = await startServer(3972);
  try {
    assert.equal((await fetch(`${base}/api/admin/recalls/replay`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/api/admin/reminders/run`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: "{}" })).status, 404);
  } finally { p2.kill(); }
});

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db.js";
import { ingestOrders } from "../src/ingest.js";
import { backupDb } from "../scripts/backup.js";
import { link, startServer } from "./helpers.js";

const CSV = readFileSync("data/sample-orders.csv", "utf8");
const TOKEN = "m".repeat(24);
let proc: ChildProcess, BASE = "";
before(async () => { ({ proc, base: BASE } = await startServer(3981, { HEARTH_METRICS_TOKEN: TOKEN })); });
after(() => { proc?.kill(); });

test("backup is consistent, verified, and restorable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-bk-"));
  try {
    const src = join(dir, "live.db");
    const db = openDb(src);
    ingestOrders(db, "h1", CSV); ingestOrders(db, "h2", CSV);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
    const r = await backupDb(src, join(dir, "out", "copy.db"));
    assert.equal(r.integrity, "ok");
    assert.equal(r.orders, n);
    assert.equal(r.households, 2);
    ingestOrders(db, "h3", CSV);              // writes after the backup do not appear in it
    const copy = openDb(join(dir, "out", "copy.db"));
    assert.equal((copy.prepare("SELECT COUNT(DISTINCT household) AS n FROM orders").get() as { n: number }).n, 2);
    copy.close();
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readiness, liveness, request ids and security.txt", async () => {
  assert.equal((await fetch(`${BASE}/healthz`)).status, 200);
  const ready = await fetch(`${BASE}/readyz`);
  assert.equal(ready.status, 200);
  assert.equal(((await ready.json()) as { ready: boolean }).ready, true);
  assert.match(ready.headers.get("x-request-id") ?? "", /^[0-9a-f-]{8}$/);
  const sec = await (await fetch(`${BASE}/.well-known/security.txt`)).text();
  assert.match(sec, /Contact: https:\/\/github\.com\/.+\/security\/advisories\/new/);
  assert.match(sec, /Expires: /);
});

test("metrics are private, correct, and label no personal data", async () => {
  assert.equal((await fetch(`${BASE}/metrics`)).status, 401, "token required");
  assert.equal((await fetch(`${BASE}/metrics`, { headers: { authorization: "Bearer nope" } })).status, 401);
  const tok = await link(BASE);
  const c = new Client({ name: "m", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
  await c.callTool({ name: "import_order_history", arguments: { csv: CSV } });
  await c.callTool({ name: "confirm_restock", arguments: { proposalId: "prop_nope", approvalCode: "0000" } }); // an error outcome
  await c.close();
  const text = await (await fetch(`${BASE}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
  assert.match(text, /hearth_tool_calls_total\{tool="import_order_history",outcome="ok"\} 1/);
  assert.match(text, /hearth_tool_calls_total\{tool="confirm_restock",outcome="error"\} 1/);
  assert.match(text, /hearth_import_rows_total\{path="mcp"\} 208/);
  assert.match(text, /hearth_http_requests_total\{route="oauth",status="3xx"\}/);
  assert.match(text, /hearth_recalls_indexed \d+/);
  assert.match(text, /hearth_open_sessions /);
  assert.ok(!text.includes(tok.access_token) && !/hh_/.test(text), "no tokens or household ids in metrics");
  const off = await startServer(3982);
  try { assert.equal((await fetch(`${off.base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404, "disabled without a configured token"); } finally { off.proc.kill(); }
});

test("graceful shutdown: SIGTERM exits cleanly and promptly", async () => {
  const { proc: p, base } = await startServer(3983);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const exited = new Promise<number | null>((ok) => p.on("exit", (code) => ok(code)));
  const t0 = Date.now();
  p.kill("SIGTERM");
  const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("timeout"), 8000))]);
  assert.notEqual(code, "timeout", "server did not exit after SIGTERM");
  assert.ok(Date.now() - t0 < 8000);
});

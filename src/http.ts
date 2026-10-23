import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Worker } from "node:worker_threads";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { openDb } from "./db.js";
import { ingestStream, type IngestReport } from "./ingest.js";
import { recallStats, syncRecalls, type RecallRecord } from "./recallIndex.js";
import { Hub } from "./hub.js";
import { dueReminders, processNewRecalls } from "./alerts.js";
import { APP_ONLY_TOOLS, createHearthServer } from "./server.js";
import { fileURLToPath } from "node:url";
import { MAX_SPEAK_CHARS, SPEAK_LANGS, startVoice, stopVoice, synthesize, voiceReady, type SpeakLang } from "./voice.js";
import { baseUrl, handleOAuth, pruneTokens, verifyToken } from "./oauth.js";
import { bedrockClient, bedrockStep, hasBedrockCredentials, validateAgentRequest, reserveBedrockCall, MODEL_ID, REGION, type WireMessage, type WireTool } from "./agent.js";
import { RateLimiter, allowedHosts, clientIp, csp, hostAllowed, originAllowed, readBody, securityHeaders, sha256b64 } from "./security.js";
import { RUNWAY_HTML } from "./ui.js";
import * as metrics from "./metrics.js";

const PORT = Number(process.env.PORT ?? 3939);
const AUTH = (process.env.HEARTH_AUTH ?? "on") !== "off";
// Auth off makes every caller the same household. That is a local-experiment switch, never a deployment mode.
if (!AUTH && (process.env.NODE_ENV === "production" || process.env.PUBLIC_URL)) {
  console.error("Refusing to start: HEARTH_AUTH=off cannot be combined with NODE_ENV=production or PUBLIC_URL.");
  process.exit(1);
}
const WEB = new URL("../web/", import.meta.url).pathname;
const DB_PATH = process.env.HEARTH_DB ?? "data/hearth.db";
const db = openDb(DB_PATH);
const MAX_UPLOAD = Number(process.env.HEARTH_MAX_UPLOAD_MB ?? 250) * 1024 * 1024;
const HOSTS = allowedHosts();
const MAX_SESSIONS = 5000;
const MAX_SESSIONS_PER_HOUSEHOLD = Number(process.env.HEARTH_MAX_SESSIONS_PER_HOUSEHOLD ?? 20);
const MAX_CONCURRENT_IMPORTS = Number(process.env.HEARTH_MAX_CONCURRENT_IMPORTS ?? 3);
let activeImports = 0;
const SESSION_IDLE_MS = 30 * 60_000;

interface Session { transport: StreamableHTTPServerTransport; household: string; last: number }
const sessions = new Map<string, Session>();
const hub = new Hub();
const adminLimit = new RateLimiter(20, 60_000);

/** A recall was just published: find its owners, store alerts, and push to anyone connected right now. */
async function fanout(fresh: RecallRecord[]) {
  const r = processNewRecalls(db, fresh);
  let notified = 0;
  for (const h of r.households) notified += await hub.notify(h);
  if (fresh.length) console.log(JSON.stringify({ level: "info", msg: "recall fanout", recalls: fresh.length, alerts: r.created, households: r.households.size, notifiedSessions: notified }));
  return { alerts: r.created, households: r.households.size, notifiedSessions: notified };
}

const mcpLimit = new RateLimiter(600, 60_000);
const agentLimit = new RateLimiter(30, 60_000);
const importLimit = new RateLimiter(10, 3600_000);
const speakLimit = new RateLimiter(120, 60_000);

// The receipt view runs inline in a sandboxed iframe; allow exactly its script by hash.
const viewHashes = [...RUNWAY_HTML.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => sha256b64(m[1]));
const PAGE_CSP = csp(viewHashes);

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".csv": "text/csv", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png" };

function cors(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const origin = req.headers.origin;
  if (pathname.startsWith("/.well-known/")) res.setHeader("access-control-allow-origin", "*"); // public discovery metadata
  else if (origin && originAllowed(req, HOSTS)) { res.setHeader("access-control-allow-origin", String(origin)); res.setHeader("vary", "origin"); }
  res.setHeader("access-control-allow-headers", "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("access-control-expose-headers", "mcp-session-id, www-authenticate");
}

const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};
const rpcError = (res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}) =>
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);

/** Resolve the caller. With auth off (local experiments only) everyone is the "demo" household. */
function authenticate(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse): { household: string; clientId: string } | null {
  if (!AUTH) return { household: "demo", clientId: "dev" };
  const t = verifyToken(db, req.headers.authorization);
  if (!t) {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"` });
    res.end(JSON.stringify({ error: "authentication required" }));
    return null;
  }
  return t;
}

async function handleMcp(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse) {
  const who = authenticate(req, res);
  if (!who) return;
  if (!mcpLimit.allow(who.household)) return rpcError(res, 429, -32002, "Rate limit exceeded", { "retry-after": String(mcpLimit.retryAfter(who.household)) });
  req.auth = { token: "redacted", clientId: who.clientId, scopes: ["household"], extra: { household: who.household } };

  const sid = req.headers["mcp-session-id"] as string | undefined;
  let body: unknown;
  if (req.method === "POST") {
    try { body = JSON.parse((await readBody(req, 5_000_000)) || "null") ?? undefined; }
    catch (e) { return rpcError(res, (e as { status?: number }).status ?? 400, -32700, "Parse error"); }
  }
  let session = sid ? sessions.get(sid) : undefined;
  // A session id is only valid for the household that created it; never reveal that it exists for anyone else.
  if (session && session.household !== who.household) session = undefined;
  if (session) session.last = Date.now();
  if (!session) {
    if (req.method === "POST" && !sid && isInitializeRequest(body)) {
      // One household cannot crowd out the rest: past its cap, its own oldest session is closed.
      const mine = [...sessions].filter(([, s]) => s.household === who.household).sort((a, b) => a[1].last - b[1].last);
      for (const [id, s] of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_HOUSEHOLD + 1))) { void s.transport.close(); sessions.delete(id); }
      if (sessions.size >= MAX_SESSIONS) pruneSessions(true);
      if (sessions.size >= MAX_SESSIONS) return rpcError(res, 503, -32003, "Server busy");
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, { transport, household: who.household, last: Date.now() }); },
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      const srv = createHearthServer({ db });
      const detach = hub.add(who.household, srv);
      const prevClose = transport.onclose;
      transport.onclose = () => { detach(); prevClose?.(); };
      await srv.connect(transport);
      session = { transport, household: who.household, last: Date.now() };
    } else return rpcError(res, sid ? 404 : 400, -32000, sid ? "Unknown session" : "Missing session id");
  }
  await session.transport.handleRequest(req, res, body);
}

function pruneSessions(force = false) {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.last > SESSION_IDLE_MS) { void s.transport.close(); sessions.delete(id); }
  if (force && sessions.size >= MAX_SESSIONS) { // evict the stalest few rather than refuse everyone
    for (const [id, s] of [...sessions].sort((a, b) => a[1].last - b[1].last).slice(0, 100)) { void s.transport.close(); sessions.delete(id); }
  }
}

/** POST /api/import  (Content-Type: text/csv) streams a large order export into the caller's household. */
async function handleImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const who = authenticate(req, res);
  if (!who) return;
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST a CSV body" });
  if (!importLimit.allow(who.household)) return sendJson(res, 429, { error: "Too many imports; try again later." }, { "retry-after": String(importLimit.retryAfter(who.household)) });
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_UPLOAD) return sendJson(res, 413, { error: `Upload larger than ${MAX_UPLOAD / 1024 / 1024} MB` });
  if (activeImports >= MAX_CONCURRENT_IMPORTS) return sendJson(res, 503, { error: "The server is busy with other imports; retry shortly." }, { "retry-after": "30" });
  activeImports++;
  const started = performance.now();
  try {
    const report = DB_PATH === ":memory:" ? await ingestStream(db, who.household, req, { maxBytes: MAX_UPLOAD }) : await importInWorker(req, who.household);
    metrics.inc("hearth_import_rows_total", { path: "upload" }, report.rowsRead); // counted here: the worker has its own metrics instance
    sendJson(res, 200, { ...report, seconds: Math.round(performance.now() - started) / 1000 });
  } catch (e) {
    console.error("import failed:", (e as Error).message);
    sendJson(res, 500, { error: "Import failed; nothing was saved for this upload." });
  } finally { activeImports--; }
}

function importInWorker(req: IncomingMessage, household: string): Promise<IngestReport> {
  return new Promise((resolve, reject) => {
    const ts = import.meta.url.endsWith(".ts"); // dev (tsx) vs compiled production build
    const w = new Worker(new URL(ts ? "./importWorker.ts" : "./importWorker.js", import.meta.url), {
      workerData: { dbPath: DB_PATH, household, maxBytes: MAX_UPLOAD, maxRows: 2_000_000 },
      execArgv: ts ? ["--import", "tsx"] : [],
    });
    let inflight = 0; let resume: (() => void) | null = null; let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    w.on("message", (m: { type: string; report?: IngestReport; message?: string }) => {
      if (m.type === "ack") { inflight--; if (inflight < 8) { resume?.(); resume = null; } }
      else if (m.type === "done") done(() => resolve(m.report!));
      else if (m.type === "error") done(() => reject(new Error(m.message)));
    });
    w.on("error", (e) => done(() => reject(e)));
    w.on("exit", (code) => { if (code !== 0) done(() => reject(new Error(`import worker exited ${code}`))); });
    (async () => {
      let bytes = 0;
      for await (const chunk of req) {
        bytes += (chunk as Buffer).byteLength;
        if (bytes > MAX_UPLOAD) { w.postMessage({ type: "end" }); return; }
        const copy = new Uint8Array(chunk as Buffer);
        w.postMessage({ type: "chunk", buf: copy }, [copy.buffer]);
        if (++inflight >= 8) await new Promise<void>((r) => (resume = r));
      }
      w.postMessage({ type: "end" });
    })().catch((e) => { done(() => reject(e)); void w.terminate(); });
  });
}

/**
 * Operator-only: replay a real notice already in the index as if it had just been published, so the whole
 * pipeline (index -> owner lookup -> alert -> MCP push) can be demonstrated on demand. Disabled unless
 * HEARTH_ADMIN_TOKEN (24+ chars) is set.
 */
/** Operator endpoints are off (404) without a long token, rate limited, constant-time compared, POST only. Returns false after answering. */
function adminGate(req: IncomingMessage, res: ServerResponse): boolean {
  const token = process.env.HEARTH_ADMIN_TOKEN ?? "";
  if (token.length < 24) { res.writeHead(404).end("Not found"); return false; }
  if (!adminLimit.allow(clientIp(req))) { sendJson(res, 429, { error: "slow down" }); return false; }
  const given = createHash("sha256").update(String(req.headers.authorization ?? "").replace(/^Bearer /i, "")).digest();
  if (!timingSafeEqual(given, createHash("sha256").update(token).digest())) { sendJson(res, 401, { error: "invalid admin token" }); return false; }
  if (req.method !== "POST") { sendJson(res, 405, { error: "POST only" }); return false; }
  return true;
}

/** Bring back recalls that are still open after the reminder delay, and tell the open sessions of the households concerned. */
async function remind(afterMs?: number) {
  const households = dueReminders(db, Date.now(), afterMs);
  let notified = 0;
  for (const h of households) notified += await hub.notify(h);
  if (households.size) console.log(JSON.stringify({ level: "info", msg: "recall reminders", households: households.size, notifiedSessions: notified }));
  return { households: households.size, notifiedSessions: notified };
}

async function handleAdminReminders(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!adminGate(req, res)) return;
  let body: { afterHours?: number };
  try { body = JSON.parse((await readBody(req, 2000)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
  const after = body.afterHours === undefined ? undefined : Math.max(0, Number(body.afterHours)) * 3_600_000;
  sendJson(res, 200, await remind(after));
}

async function handleAdminReplay(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!adminGate(req, res)) return;
  let body: { source?: string; titleContains?: string };
  try { body = JSON.parse((await readBody(req, 5000)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
  const row = db.prepare("SELECT * FROM recalls WHERE source = ? AND instr(lower(title), lower(?)) > 0 ORDER BY date DESC LIMIT 1").get(String(body.source ?? ""), String(body.titleContains ?? "")) as Record<string, string> | undefined;
  if (!row) return sendJson(res, 404, { error: "no such notice in the index" });
  db.prepare("DELETE FROM alerts WHERE source = ? AND ext_id = ?").run(row.source, row.ext_id);
  const rec: RecallRecord = { source: row.source, extId: row.ext_id, region: row.region as RecallRecord["region"], date: row.date, title: row.title, product: row.product, text: row.text, url: row.url, hazard: row.hazard, remedy: row.remedy, image: row.image || undefined };
  const out = await fanout([rec]);
  sendJson(res, 200, { replayed: { source: rec.source, id: rec.extId, title: rec.title, date: rec.date }, ...out });
}

/** POST /api/speak {text, lang}: WAV audio from the neural voice, for the person who is signed in. 503 when no voice is installed (the page then uses the browser's). */
async function handleSpeak(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === "/api/speak/status") {
    if (!authenticate(req, res)) return true;
    sendJson(res, 200, { neural: voiceReady() });
    return true;
  }
  if (url.pathname !== "/api/speak") return false;
  const who = authenticate(req, res);
  if (!who) return true;
  if (req.method !== "POST") { sendJson(res, 405, { error: "POST only" }); return true; }
  if (!speakLimit.allow(who.household)) { sendJson(res, 429, { error: "Slow down a little." }, { "retry-after": String(speakLimit.retryAfter(who.household)) }); return true; }
  let body: { text?: unknown; lang?: unknown };
  try { body = JSON.parse((await readBody(req, 4000)) || "null") ?? {}; } catch { sendJson(res, 400, { error: "bad json" }); return true; }
  const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
  if (!text || text.length > MAX_SPEAK_CHARS) { sendJson(res, 400, { error: `text must be 1 to ${MAX_SPEAK_CHARS} characters` }); return true; }
  if (!SPEAK_LANGS.includes(body.lang as SpeakLang)) { sendJson(res, 400, { error: "lang must be en, es or hi" }); return true; }
  if (!voiceReady()) { sendJson(res, 503, { error: "no neural voice is installed; the page uses the browser's voice" }); return true; }
  const wav = await synthesize(text, body.lang as SpeakLang);
  if (!wav) { sendJson(res, 502, { error: "the neural voice could not speak that" }); return true; }
  res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "cache-control": "private, no-store" }).end(wav);
  return true;
}

async function handleAgent(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === "/api/agent/status") {
    sendJson(res, 200, { mode: hasBedrockCredentials() ? "bedrock" : "local", model: hasBedrockCredentials() ? MODEL_ID : null, region: REGION });
    return true;
  }
  if (url.pathname === "/api/agent/step") {
    const who = authenticate(req, res); // paid model calls are never anonymous
    if (!who) return true;
    if (req.method !== "POST") { sendJson(res, 405, { error: "POST only" }); return true; }
    if (!agentLimit.allow(who.household)) { sendJson(res, 429, { error: "Slow down a little." }, { "retry-after": String(agentLimit.retryAfter(who.household)) }); return true; }
    if (!hasBedrockCredentials()) { sendJson(res, 503, { error: "Bedrock is not configured; the simulator uses its offline router." }); return true; }
    try {
      const body = JSON.parse((await readBody(req, 400_000)) || "null");
      const bad = validateAgentRequest(body);
      if (bad) { sendJson(res, 400, { error: bad }); return true; }
      const budget = reserveBedrockCall(db);
      if (!budget.ok) { sendJson(res, 429, { error: `Daily model-call limit reached (${budget.max}). The simulator will use its offline router; raise HEARTH_BEDROCK_DAILY_CALLS only if you accept the cost.` }); return true; }
      // Defence in depth: tools that only an on-screen card may call are never offered to the model, whatever the browser sends.
      const offered = (body.tools as WireTool[]).filter((tool) => !(APP_ONLY_TOOLS as readonly string[]).includes(tool.name));
      sendJson(res, 200, await bedrockStep(bedrockClient(), body.messages as WireMessage[], offered));
    } catch (e) {
      if ((e as { status?: number }).status === 413) { sendJson(res, 413, { error: "request too large" }); return true; }
      console.error("bedrock:", (e as Error).name);
      sendJson(res, 502, { error: `Bedrock call failed: ${(e as Error).name}. Check AWS credentials, region and model access.` });
    }
    return true;
  }
  return false;
}

function serveStatic(url: URL, res: ServerResponse) {
  const sample = /^\/demo\/(sample-(?:orders|family|india)\.csv)$/.exec(url.pathname);
  if (sample) {
    res.writeHead(200, { "content-type": "text/csv" }).end(readFileSync(new URL(`../data/${sample[1]}`, import.meta.url)));
    return;
  }
  const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(WEB, rel);
  if (!file.startsWith(WEB) || /(^|[/\\])\./.test(rel)) { res.writeHead(404).end("Not found"); return; }
  // Open once and check the same descriptor, so the file cannot be swapped between the check and the read.
  let body: Buffer;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    if (!fstatSync(fd).isFile()) throw new Error("not a file");
    body = readFileSync(fd);
  } catch { res.writeHead(404).end("Not found"); return; } finally { if (fd !== undefined) closeSync(fd); }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" }).end(body);
}

const routeGroup = (p: string) => p === "/mcp" ? "mcp" : p.startsWith("/api/import") ? "import" : p.startsWith("/api/agent") ? "agent" : p.startsWith("/api/speak") ? "speak" : p.startsWith("/api/admin") ? "admin" : ["/authorize", "/token", "/register", "/revoke"].includes(p) || p.startsWith("/.well-known/oauth") ? "oauth" : p === "/healthz" || p === "/readyz" || p === "/metrics" ? "ops" : "static";

/** GET /metrics (Prometheus text). Off unless HEARTH_METRICS_TOKEN (16+ chars) is set; compared in constant time. */
function handleMetrics(req: IncomingMessage, res: ServerResponse) {
  const token = process.env.HEARTH_METRICS_TOKEN ?? "";
  if (token.length < 16) { res.writeHead(404).end("Not found"); return; }
  const given = createHash("sha256").update(String(req.headers.authorization ?? "").replace(/^Bearer /i, "")).digest();
  if (!timingSafeEqual(given, createHash("sha256").update(token).digest())) { res.writeHead(401).end("unauthorized"); return; }
  res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" }).end(metrics.render());
}

/** Ready = the database answers and the recall index has data (live or bundled snapshot). */
function handleReady(res: ServerResponse) {
  try {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM recalls").get() as { n: number }).n;
    const ok = n > 0 || process.env.HEARTH_RECALLS_SYNC === "off";
    sendJson(res, ok ? 200 : 503, { ready: ok, recallsIndexed: n, openSessions: sessions.size });
  } catch { sendJson(res, 503, { ready: false }); }
}

const SECURITY_TXT = "Contact: https://github.com/anshul23102/hearth-alexa-mcp/security/advisories/new\nPreferred-Languages: en\nExpires: 2027-10-21T00:00:00.000Z\nPolicy: https://github.com/anshul23102/hearth-alexa-mcp/blob/main/SECURITY.md\n";

const server = createServer(async (req, res) => {
  const t0 = performance.now();
  const reqId = randomUUID().slice(0, 8);
  res.setHeader("x-request-id", reqId);
  const url = new URL(req.url ?? "/", "http://x");
  res.on("finish", () => {
    const group = routeGroup(url.pathname);
    metrics.inc("hearth_http_requests_total", { route: group, status: `${Math.floor(res.statusCode / 100)}xx` });
    if (res.statusCode === 429) metrics.inc("hearth_rate_limited_total", { route: group });
    if (group !== "static" && group !== "ops") console.log(JSON.stringify({ level: "info", ts: new Date().toISOString(), reqId, method: req.method, route: group, status: res.statusCode, ms: Math.round(performance.now() - t0) }));
  });
  securityHeaders(res, url.pathname === "/" || url.pathname.endsWith(".html") ? PAGE_CSP : undefined);
  if (!hostAllowed(req, HOSTS)) { res.writeHead(421).end("Unrecognized Host"); return; } // DNS-rebinding defence
  const apiish = url.pathname === "/mcp" || url.pathname.startsWith("/api/") || ["/token", "/register", "/revoke"].includes(url.pathname);
  if (apiish && !originAllowed(req, HOSTS)) { res.writeHead(403).end("Origin not allowed"); return; }
  cors(req, res, url.pathname);
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  try {
    if (url.pathname === "/mcp") return await handleMcp(req, res);
    if (await handleOAuth(db, req, res, url)) return;
    if (await handleAgent(req, res, url)) return;
    if (await handleSpeak(req, res, url)) return;
    if (url.pathname === "/api/import") return await handleImport(req, res);
    if (url.pathname === "/api/admin/recalls/replay") return await handleAdminReplay(req, res);
    if (url.pathname === "/api/admin/reminders/run") return await handleAdminReminders(req, res);
    if (url.pathname === "/healthz") { res.writeHead(200).end("ok"); return; }
    if (url.pathname === "/readyz") return handleReady(res);
    if (url.pathname === "/metrics") return handleMetrics(req, res);
    if (url.pathname === "/.well-known/security.txt") { res.writeHead(200, { "content-type": "text/plain" }).end(SECURITY_TXT); return; }
    if (url.pathname === "/api/recalls/stats") return sendJson(res, 200, recallStats(db));
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }).end("Method not allowed"); return; }
    serveStatic(url, res);
  } catch (e) {
    console.error((e as Error).message);
    if (!res.headersSent) res.writeHead((e as { status?: number }).status === 413 ? 413 : 500).end("Request failed");
  }
});
server.listen(PORT, () => {
  setInterval(() => { pruneSessions(); pruneTokens(db); }, 5 * 60_000).unref();
  // Keep the recall index fresh without ever blocking a request: check at start and every 30 minutes; live data is re-downloaded daily, a snapshot fallback is retried every 10 minutes.
  if (process.env.HEARTH_RECALLS_SYNC !== "off") {
    const run = () => syncRecalls(db)
      .then(async (r) => {
        console.log("recall sync:", r.map((x) => `${x.source}=${x.count}(${x.mode})${x.fresh.length ? ` +${x.fresh.length} new` : ""}`).join(" "));
        const fresh = r.flatMap((x) => x.fresh);
        if (fresh.length) await fanout(fresh); // new notices are matched to owners and pushed immediately
      })
      .catch((e) => console.error("recall sync failed:", e.message));
    void run();
    setInterval(run, 30 * 60_000).unref(); // cheap: a live index younger than 24 h returns without touching the network
  }
  void startVoice(fileURLToPath(new URL("..", import.meta.url))).catch((e) => console.error("neural voice failed to start:", e.message));
  void remind().catch((e) => console.error("reminders failed:", e.message));
  setInterval(() => void remind().catch((e) => console.error("reminders failed:", e.message)), 30 * 60_000).unref();
  console.log(`Hearth MCP on http://localhost:${PORT}/mcp  (auth ${AUTH ? "on" : "off"})  simulator: http://localhost:${PORT}/`);
});

metrics.gauge("hearth_open_sessions", () => sessions.size);
metrics.gauge("hearth_push_sessions", () => hub.size);
metrics.gauge("hearth_recalls_indexed", () => (db.prepare("SELECT COUNT(*) AS n FROM recalls").get() as { n: number }).n);

/** SIGTERM/SIGINT: stop taking connections, close MCP sessions, checkpoint and close the database, then exit. */
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(() => {
    void Promise.allSettled([...sessions.values()].map((s) => s.transport.close())).then(() => {
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
  });
  server.closeIdleConnections();
  stopVoice();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { openDb } from "./db.js";
import { ingestStream, type IngestReport } from "./ingest.js";
import { recallStats, syncRecalls } from "./recallIndex.js";
import { createHearthServer } from "./server.js";
import { baseUrl, handleOAuth, pruneTokens, verifyToken } from "./oauth.js";
import { bedrockClient, bedrockStep, hasBedrockCredentials, validateAgentRequest, MODEL_ID, REGION, type WireMessage, type WireTool } from "./agent.js";
import { RateLimiter, allowedHosts, clientIp, csp, hostAllowed, originAllowed, readBody, securityHeaders, sha256b64 } from "./security.js";
import { RUNWAY_HTML } from "./ui.js";

const PORT = Number(process.env.PORT ?? 3939);
const AUTH = (process.env.HEARTH_AUTH ?? "on") !== "off";
const WEB = new URL("../web/", import.meta.url).pathname;
const DB_PATH = process.env.HEARTH_DB ?? "data/hearth.db";
const db = openDb(DB_PATH);
const MAX_UPLOAD = Number(process.env.HEARTH_MAX_UPLOAD_MB ?? 250) * 1024 * 1024;
const HOSTS = allowedHosts();
const MAX_SESSIONS = 5000;
const SESSION_IDLE_MS = 30 * 60_000;

interface Session { transport: StreamableHTTPServerTransport; household: string; last: number }
const sessions = new Map<string, Session>();

const mcpLimit = new RateLimiter(600, 60_000);
const agentLimit = new RateLimiter(30, 60_000);
const importLimit = new RateLimiter(10, 3600_000);

// The receipt view runs inline in a sandboxed iframe; allow exactly its script by hash.
const viewHashes = [...RUNWAY_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => sha256b64(m[1]));
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
      if (sessions.size >= MAX_SESSIONS) pruneSessions(true);
      if (sessions.size >= MAX_SESSIONS) return rpcError(res, 503, -32003, "Server busy");
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, { transport, household: who.household, last: Date.now() }); },
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      await createHearthServer({ db }).connect(transport);
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
  const started = performance.now();
  try {
    const report = DB_PATH === ":memory:" ? await ingestStream(db, who.household, req, { maxBytes: MAX_UPLOAD }) : await importInWorker(req, who.household);
    sendJson(res, 200, { ...report, seconds: Math.round(performance.now() - started) / 1000 });
  } catch (e) {
    console.error("import failed:", (e as Error).message);
    sendJson(res, 500, { error: "Import failed; nothing was saved for this upload." });
  }
}

function importInWorker(req: IncomingMessage, household: string): Promise<IngestReport> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./importWorker.ts", import.meta.url), {
      workerData: { dbPath: DB_PATH, household, maxBytes: MAX_UPLOAD, maxRows: 2_000_000 },
      execArgv: ["--import", "tsx"],
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
      sendJson(res, 200, await bedrockStep(bedrockClient(), (body.messages as WireMessage[]).slice(-30), body.tools as WireTool[]));
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
  if (url.pathname === "/demo/sample-orders.csv") {
    res.writeHead(200, { "content-type": "text/csv" }).end(readFileSync(new URL("../data/sample-orders.csv", import.meta.url)));
    return;
  }
  const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(WEB, rel);
  if (!file.startsWith(WEB) || /(^|[/\\])\./.test(rel) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end("Not found"); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" }).end(readFileSync(file));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
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
    if (url.pathname === "/api/import") return await handleImport(req, res);
    if (url.pathname === "/healthz") { res.writeHead(200).end("ok"); return; }
    if (url.pathname === "/api/recalls/stats") return sendJson(res, 200, recallStats(db));
    serveStatic(url, res);
  } catch (e) {
    console.error((e as Error).message);
    if (!res.headersSent) res.writeHead((e as { status?: number }).status === 413 ? 413 : 500).end("Request failed");
  }
}).listen(PORT, () => {
  setInterval(() => { pruneSessions(); pruneTokens(db); }, 5 * 60_000).unref();
  // Keep the recall index fresh without ever blocking a request: sync at start (no-op if < 24h old), then every 6h.
  if (process.env.HEARTH_RECALLS_SYNC !== "off") {
    const run = () => syncRecalls(db).then((r) => console.log("recall sync:", r.map((x) => `${x.source}=${x.count}(${x.mode})`).join(" "))).catch((e) => console.error("recall sync failed:", e.message));
    void run();
    setInterval(run, 6 * 3600_000).unref();
  }
  console.log(`Hearth MCP on http://localhost:${PORT}/mcp  (auth ${AUTH ? "on" : "off"})  simulator: http://localhost:${PORT}/`);
});

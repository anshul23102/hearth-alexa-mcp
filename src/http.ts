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
import { baseUrl, handleOAuth, verifyToken } from "./oauth.js";
import { bedrockClient, bedrockStep, hasBedrockCredentials, MODEL_ID, REGION, type WireMessage, type WireTool } from "./agent.js";

const PORT = Number(process.env.PORT ?? 3939);
const AUTH = (process.env.HEARTH_AUTH ?? "on") !== "off";
const WEB = new URL("../web/", import.meta.url).pathname;
const DB_PATH = process.env.HEARTH_DB ?? "data/hearth.db";
const db = openDb(DB_PATH);
const MAX_UPLOAD = Number(process.env.HEARTH_MAX_UPLOAD_MB ?? 250) * 1024 * 1024;
const sessions = new Map<string, StreamableHTTPServerTransport>();

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".csv": "text/csv", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png" };

function cors(res: ServerResponse) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("access-control-expose-headers", "mcp-session-id, www-authenticate");
}
const readJson = (req: IncomingMessage) => new Promise<unknown>((ok, bad) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 5e6) bad(new Error("too large")); });
  req.on("end", () => { try { ok(b ? JSON.parse(b) : undefined); } catch (e) { bad(e); } });
});

async function handleMcp(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse) {
  const base = baseUrl(req);
  if (AUTH) {
    const t = verifyToken(req.headers.authorization);
    if (!t) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Authentication required" }, id: null }));
      return;
    }
    req.auth = { token: t.token, clientId: t.clientId, scopes: ["household"], extra: { household: t.household } };
  } else {
    req.auth = { token: "dev", clientId: "dev", scopes: [], extra: { household: "demo" } };
  }
  const sid = req.headers["mcp-session-id"] as string | undefined;
  let body: unknown;
  if (req.method === "POST") {
    try { body = await readJson(req); } catch { res.writeHead(400).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null })); return; }
  }
  let transport = sid ? sessions.get(sid) : undefined;
  if (!transport) {
    if (req.method === "POST" && !sid && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, transport!); },
      });
      transport.onclose = () => { if (transport!.sessionId) sessions.delete(transport!.sessionId); };
      await createHearthServer({ db }).connect(transport);
    } else {
      res.writeHead(sid ? 404 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: sid ? "Unknown session" : "Missing session id" }, id: null }));
      return;
    }
  }
  await transport.handleRequest(req, res, body);
}

/** POST /api/import  (Content-Type: text/csv) streams a large order export into the caller's household. */
async function handleImport(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse): Promise<void> {
  const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  let household = "demo";
  if (AUTH) {
    const t = verifyToken(req.headers.authorization);
    if (!t) { res.writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"` }).end(JSON.stringify({ error: "authentication required" })); return; }
    household = t.household;
  }
  if (req.method !== "POST") return send(405, { error: "POST a CSV body" });
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_UPLOAD) return send(413, { error: `Upload larger than ${MAX_UPLOAD / 1024 / 1024} MB` });

  const started = performance.now();
  try {
    let report: IngestReport;
    if (DB_PATH === ":memory:") report = await ingestStream(db, household, req, { maxBytes: MAX_UPLOAD });
    else report = await importInWorker(req, household);
    send(200, { ...report, seconds: Math.round((performance.now() - started)) / 1000 });
  } catch (e) {
    console.error("import failed:", (e as Error).message);
    send(500, { error: "Import failed; nothing was saved for this upload." });
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
        const copy = new Uint8Array(chunk as Buffer); // detach from the socket buffer
        w.postMessage({ type: "chunk", buf: copy }, [copy.buffer]);
        if (++inflight >= 8) await new Promise<void>((r) => (resume = r)); // backpressure
      }
      w.postMessage({ type: "end" });
    })().catch((e) => { done(() => reject(e)); void w.terminate(); });
  });
}

async function handleAgent(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/agent/status") {
    send(200, { mode: hasBedrockCredentials() ? "bedrock" : "local", model: hasBedrockCredentials() ? MODEL_ID : null, region: REGION });
    return true;
  }
  if (url.pathname === "/api/agent/step" && req.method === "POST") {
    if (!hasBedrockCredentials()) { send(503, { error: "Bedrock is not configured; the simulator uses its offline router." }); return true; }
    try {
      const body = (await readJson(req)) as { messages: WireMessage[]; tools: WireTool[] };
      if (!Array.isArray(body?.messages) || !Array.isArray(body?.tools)) { send(400, { error: "messages and tools are required" }); return true; }
      send(200, await bedrockStep(bedrockClient(), body.messages.slice(-30), body.tools));
    } catch (e) {
      console.error("bedrock:", e);
      send(502, { error: `Bedrock call failed: ${(e as Error).name}. Check AWS credentials, region and model access.` });
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
  if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end("Not found"); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" }).end(readFileSync(file));
}

createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/mcp") return await handleMcp(req, res);
    if (await handleOAuth(req, res, url)) return;
    if (await handleAgent(req, res, url)) return;
    if (url.pathname === "/api/import") return await handleImport(req, res);
    if (url.pathname === "/healthz") { res.writeHead(200).end("ok"); return; }
    if (url.pathname === "/api/recalls/stats") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(recallStats(db))); return; }
    serveStatic(url, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end("Internal error");
  }
}).listen(PORT, () => {
  // Keep the recall index fresh without ever blocking a request: sync at start (no-op if < 24h old), then every 6h.
  if (process.env.HEARTH_RECALLS_SYNC !== "off") {
    const run = () => syncRecalls(db).then((r) => console.log("recall sync:", r.map((x) => `${x.source}=${x.count}(${x.mode})`).join(" "))).catch((e) => console.error("recall sync failed:", e.message));
    void run();
    setInterval(run, 6 * 3600_000).unref();
  }
  console.log(`Hearth MCP on http://localhost:${PORT}/mcp  (auth ${AUTH ? "on" : "off"})  simulator: http://localhost:${PORT}/`);
});
// console.log(`Hearth MCP on http://localhost:${PORT}/mcp  (auth ${AUTH ? "on" : "off"})  simulator: http://localhost:${PORT}/`));

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { openDb } from "./db.js";
import { createHearthServer } from "./server.js";
import { baseUrl, handleOAuth, verifyToken } from "./oauth.js";

const PORT = Number(process.env.PORT ?? 3939);
const AUTH = (process.env.HEARTH_AUTH ?? "on") !== "off";
const WEB = new URL("../web/", import.meta.url).pathname;
const db = openDb();
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
    if (url.pathname === "/healthz") { res.writeHead(200).end("ok"); return; }
    serveStatic(url, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end("Internal error");
  }
}).listen(PORT, () => console.log(`Hearth MCP on http://localhost:${PORT}/mcp  (auth ${AUTH ? "on" : "off"})  simulator: http://localhost:${PORT}/`));

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// A deliberately small OAuth 2.1 authorization server (authorization code + PKCE S256,
// dynamic client registration). It exists so the account-linking path Alexa+ expects can
// be exercised end to end; in production this is replaced by the household's real IdP.

interface Client { id: string; redirectUris: string[] }
interface Code { clientId: string; redirectUri: string; challenge: string; household: string; exp: number }
const clients = new Map<string, Client>();
const codes = new Map<string, Code>();
const tokens = new Map<string, { household: string; clientId: string; exp: number }>();
const refresh = new Map<string, { household: string; clientId: string }>();

const rand = (n = 24) => randomBytes(n).toString("base64url");
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage) => new Promise<string>((ok, bad) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 1e6) bad(new Error("too large")); });
  req.on("end", () => ok(b));
  req.on("error", bad);
});

export const baseUrl = (req: IncomingMessage) =>
  process.env.PUBLIC_URL ?? `${(req.headers["x-forwarded-proto"] as string) ?? "http"}://${req.headers.host}`;

export function verifyToken(header: string | undefined): { token: string; household: string; clientId: string } | null {
  const m = header?.match(/^Bearer (.+)$/i);
  if (!m) return null;
  const t = tokens.get(m[1]);
  if (!t || t.exp < Date.now()) return null;
  return { token: m[1], household: t.household, clientId: t.clientId };
}

export async function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const base = baseUrl(req);
  const p = url.pathname;

  if (p.startsWith("/.well-known/oauth-protected-resource")) {
    json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["household"] });
    return true;
  }
  if (p === "/.well-known/oauth-authorization-server") {
    json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["household"],
    });
    return true;
  }
  if (p === "/register" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const uris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (uris.length === 0) { json(res, 400, { error: "invalid_redirect_uri" }); return true; }
    const c = { id: `cl_${rand(9)}`, redirectUris: uris };
    clients.set(c.id, c);
    json(res, 201, { client_id: c.id, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    return true;
  }
  if (p === "/authorize" && req.method === "GET") {
    const q = url.searchParams;
    const c = clients.get(q.get("client_id") ?? "");
    if (!c || !c.redirectUris.includes(q.get("redirect_uri") ?? "")) { res.writeHead(400).end("Unknown client or redirect_uri"); return true; }
    if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
      res.writeHead(400).end("PKCE S256 is required"); return true;
    }
    const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
    const hidden = ["client_id", "redirect_uri", "state", "code_challenge"].map((k) => `<input type=hidden name=${k} value="${esc(q.get(k) ?? "")}">`).join("");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Link Hearth</title>
<style>body{font:16px/1.5 system-ui;background:#f6f1e9;color:#241b14;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fffdf9;border:1px solid #e4d9c8;border-radius:16px;padding:32px;max-width:380px;box-shadow:0 8px 30px #3a2a1a14}
h1{font-size:22px;margin:0 0 8px}p{color:#6b5b4a;margin:0 0 20px}button{width:100%;padding:12px;border:0;border-radius:10px;background:#b4471c;color:#fff;font:600 16px system-ui;cursor:pointer}</style>
<main><h1>Link Hearth to Alexa+</h1><p>Hearth will read your order history and plan restocks. It will never order without your yes.</p>
<form method=post action=/authorize>${hidden}<button>Link account</button></form></main>`);
    return true;
  }
  if (p === "/authorize" && req.method === "POST") {
    const f = new URLSearchParams(await readBody(req));
    const c = clients.get(f.get("client_id") ?? "");
    const redirect = f.get("redirect_uri") ?? "";
    if (!c || !c.redirectUris.includes(redirect) || !f.get("code_challenge")) { res.writeHead(400).end("Bad request"); return true; }
    const code = rand();
    codes.set(code, { clientId: c.id, redirectUri: redirect, challenge: f.get("code_challenge")!, household: "demo", exp: Date.now() + 120_000 });
    const to = new URL(redirect);
    to.searchParams.set("code", code);
    if (f.get("state")) to.searchParams.set("state", f.get("state")!);
    res.writeHead(302, { location: to.toString() }).end();
    return true;
  }
  if (p === "/token" && req.method === "POST") {
    const f = new URLSearchParams(await readBody(req));
    const issue = (household: string, clientId: string) => {
      const access = rand(32), r = rand(32);
      tokens.set(access, { household, clientId, exp: Date.now() + 3600_000 });
      refresh.set(r, { household, clientId });
      json(res, 200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: r, scope: "household" });
    };
    if (f.get("grant_type") === "authorization_code") {
      const c = codes.get(f.get("code") ?? "");
      codes.delete(f.get("code") ?? "");
      const verifier = f.get("code_verifier") ?? "";
      const ok = c && c.exp > Date.now() && c.clientId === f.get("client_id") && c.redirectUri === f.get("redirect_uri") &&
        createHash("sha256").update(verifier).digest("base64url") === c.challenge;
      if (!ok) { json(res, 400, { error: "invalid_grant" }); return true; }
      issue(c!.household, c!.clientId);
      return true;
    }
    if (f.get("grant_type") === "refresh_token") {
      const r = refresh.get(f.get("refresh_token") ?? "");
      if (!r) { json(res, 400, { error: "invalid_grant" }); return true; }
      issue(r.household, r.clientId);
      return true;
    }
    json(res, 400, { error: "unsupported_grant_type" });
    return true;
  }
  return false;
}

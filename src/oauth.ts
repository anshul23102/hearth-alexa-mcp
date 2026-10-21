import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { RateLimiter, clientIp, readBody, safeRedirectUri } from "./security.js";

// A deliberately small OAuth 2.1 authorization server (authorization code + PKCE S256, dynamic client
// registration, refresh-token rotation, revocation). It exists so the account-linking path Alexa+ expects
// can be exercised end to end. In production the consent step is replaced by the household's real identity
// provider; everything downstream (hashed tokens, per-household scoping) stays the same.

const ACCESS_TTL = 3600_000;
const REFRESH_TTL = 30 * 24 * 3600_000;
const MAX_CLIENTS = 10_000;

interface Pending { clientId: string; redirectUri: string; challenge: string; state: string; exp: number }
interface Code { clientId: string; redirectUri: string; challenge: string; household: string; exp: number }
const pending = new Map<string, Pending>(); // consent nonce -> authorization request (CSRF binding)
const codes = new Map<string, Code>();

const num = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const registerLimit = new RateLimiter(num("HEARTH_RATE_REGISTER", 20), 3600_000);
const tokenLimit = new RateLimiter(num("HEARTH_RATE_TOKEN", 60), 60_000);
const authorizeLimit = new RateLimiter(num("HEARTH_RATE_AUTHORIZE", 60), 60_000);

const rand = (n = 24) => randomBytes(n).toString("base64url");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...headers });
  res.end(JSON.stringify(body));
};
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const sweep = (m: Map<string, { exp: number }>) => { const now = Date.now(); for (const [k, v] of m) if (v.exp < now) m.delete(k); };

export const baseUrl = (req: IncomingMessage) =>
  process.env.PUBLIC_URL ?? `${(req.headers["x-forwarded-proto"] as string) ?? "http"}://${req.headers.host}`;

export function verifyToken(db: DatabaseSync, header: string | undefined): { household: string; clientId: string } | null {
  const m = header?.match(/^Bearer ([\w-]{20,200})$/i);
  if (!m) return null;
  const row = db.prepare("SELECT household, client_id, exp FROM oauth_tokens WHERE hash = ? AND kind = 'access'").get(hash(m[1])) as { household: string; client_id: string; exp: number } | undefined;
  if (!row || row.exp < Date.now()) return null;
  return { household: row.household, clientId: row.client_id };
}

function issue(db: DatabaseSync, res: ServerResponse, household: string, clientId: string) {
  const access = rand(32), refresh = rand(32), now = Date.now();
  const ins = db.prepare("INSERT INTO oauth_tokens (hash, kind, client_id, household, exp) VALUES (?, ?, ?, ?, ?)");
  ins.run(hash(access), "access", clientId, household, now + ACCESS_TTL);
  ins.run(hash(refresh), "refresh", clientId, household, now + REFRESH_TTL);
  json(res, 200, { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: "household" });
}

export async function handleOAuth(db: DatabaseSync, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const base = baseUrl(req);
  const p = url.pathname;
  const ip = clientIp(req);

  if (p.startsWith("/.well-known/oauth-protected-resource")) {
    json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["household"] });
    return true;
  }
  if (p === "/.well-known/oauth-authorization-server") {
    json(res, 200, {
      issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["household"],
    });
    return true;
  }

  if (p === "/register" && req.method === "POST") {
    if (!registerLimit.allow(ip)) { json(res, 429, { error: "too_many_requests" }, { "retry-after": String(registerLimit.retryAfter(ip)) }); return true; }
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try { body = JSON.parse((await readBody(req, 10_000)) || "{}"); } catch { json(res, 400, { error: "invalid_client_metadata" }); return true; }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (uris.length === 0 || uris.length > 5 || !uris.every((u) => u.length < 500 && safeRedirectUri(u))) { json(res, 400, { error: "invalid_redirect_uri", error_description: "Use https, or http on localhost; no fragments; at most 5." }); return true; }
    const count = (db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get() as { n: number }).n;
    if (count >= MAX_CLIENTS) { json(res, 503, { error: "temporarily_unavailable" }); return true; }
    const id = `cl_${rand(12)}`;
    db.prepare("INSERT INTO oauth_clients (id, redirect_uris, name, created_at) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(uris), String(body.client_name ?? "").slice(0, 80), Date.now());
    json(res, 201, { client_id: id, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    return true;
  }

  if (p === "/authorize" && req.method === "GET") {
    if (!authorizeLimit.allow(ip)) { res.writeHead(429).end("Too many requests"); return true; }
    const q = url.searchParams;
    const c = db.prepare("SELECT redirect_uris, name FROM oauth_clients WHERE id = ?").get(q.get("client_id") ?? "") as { redirect_uris: string; name: string } | undefined;
    const redirect = q.get("redirect_uri") ?? "";
    if (!c || !(JSON.parse(c.redirect_uris) as string[]).includes(redirect)) { res.writeHead(400).end("Unknown client or redirect_uri"); return true; }
    if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !/^[\w-]{43}$/.test(q.get("code_challenge") ?? "")) { res.writeHead(400).end("PKCE S256 is required"); return true; }
    sweep(pending);
    if (pending.size > 5000) { res.writeHead(503).end("Busy"); return true; }
    const nonce = rand(24);
    pending.set(nonce, { clientId: q.get("client_id")!, redirectUri: redirect, challenge: q.get("code_challenge")!, state: (q.get("state") ?? "").slice(0, 200), exp: Date.now() + 600_000 });
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Link Hearth</title>
<style>@font-face{font-family:B;src:url(/fonts/bricolage-700.woff2)}@font-face{font-family:M;src:url(/fonts/martian-400.woff2)}
body{font:14px/1.55 M,ui-monospace,monospace;background:#2236d9;color:#f3f6f8;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px}
main{background:#f3f6f8;color:#0c1230;padding:32px 28px;max-width:400px;filter:drop-shadow(0 12px 22px #05084a66)}
h1{font:700 34px/1 B,system-ui,sans-serif;letter-spacing:-.02em;margin:0 0 12px}p{margin:0 0 10px;color:#4b5470}ul{margin:0 0 22px;padding:0;list-style:none;border-top:2px dotted #b9c2d0}
li{padding:8px 0;border-bottom:2px dotted #b9c2d0;color:#0c1230;font-size:12.5px}
button{width:100%;padding:15px;border:2px solid #0c1230;background:#0c1230;color:#f3f6f8;font:600 12px M,monospace;letter-spacing:.07em;text-transform:uppercase;cursor:pointer;box-shadow:4px 4px 0 #2236d9}
button:hover{transform:translate(-1px,-1px)}button:focus-visible{outline:3px solid #2236d9;outline-offset:3px}</style>
<main><h1>Link Hearth to Alexa+</h1><p>${esc(c.name || "An Alexa+ client")} is asking Hearth to:</p>
<ul><li>Read your imported order history</li><li>Plan restocks for you to approve</li><li>Place an order only after you say yes</li></ul>
<form method=post action=/authorize><input type=hidden name=nonce value="${esc(nonce)}"><button>Allow and link</button></form></main>`);
    return true;
  }

  if (p === "/authorize" && req.method === "POST") {
    if (!authorizeLimit.allow(ip)) { res.writeHead(429).end("Too many requests"); return true; }
    // Cross-site form posts are refused: the browser must say this request came from our own consent page.
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin") { res.writeHead(403).end("Cross-site request refused"); return true; }
    const f = new URLSearchParams(await readBody(req, 4000));
    const nonce = f.get("nonce") ?? "";
    const pend = pending.get(nonce);
    pending.delete(nonce); // single use
    if (!pend || pend.exp < Date.now()) { res.writeHead(400).end("This consent page expired. Start again."); return true; }
    const household = `hh_${rand(12)}`;
    const code = rand(32);
    sweep(codes);
    codes.set(code, { clientId: pend.clientId, redirectUri: pend.redirectUri, challenge: pend.challenge, household, exp: Date.now() + 60_000 });
    const to = new URL(pend.redirectUri);
    to.searchParams.set("code", code);
    if (pend.state) to.searchParams.set("state", pend.state);
    res.writeHead(302, { location: to.toString(), "cache-control": "no-store" }).end();
    return true;
  }

  if (p === "/token" && req.method === "POST") {
    if (!tokenLimit.allow(ip)) { json(res, 429, { error: "too_many_requests" }, { "retry-after": String(tokenLimit.retryAfter(ip)) }); return true; }
    const f = new URLSearchParams(await readBody(req, 10_000));
    if (f.get("grant_type") === "authorization_code") {
      const code = f.get("code") ?? "";
      const c = codes.get(code);
      codes.delete(code); // single use, even on failure
      const verifier = f.get("code_verifier") ?? "";
      let ok = false;
      if (c && c.exp > Date.now() && c.clientId === f.get("client_id") && c.redirectUri === f.get("redirect_uri") && /^[\w~.-]{43,128}$/.test(verifier)) {
        const a = Buffer.from(createHash("sha256").update(verifier).digest("base64url")), b = Buffer.from(c.challenge);
        ok = a.length === b.length && timingSafeEqual(a, b);
      }
      if (!ok) { json(res, 400, { error: "invalid_grant" }); return true; }
      issue(db, res, c!.household, c!.clientId);
      return true;
    }
    if (f.get("grant_type") === "refresh_token") {
      const h = hash(f.get("refresh_token") ?? "");
      const row = db.prepare("SELECT household, client_id, exp, kind FROM oauth_tokens WHERE hash = ? AND kind IN ('refresh', 'used_refresh')").get(h) as { household: string; client_id: string; exp: number; kind: string } | undefined;
      if (!row || row.exp < Date.now() || row.client_id !== f.get("client_id")) { json(res, 400, { error: "invalid_grant" }); return true; }
      if (row.kind === "used_refresh") {
        // A rotated token came back: someone has a copy. Revoke every token this grant ever issued.
        db.prepare("DELETE FROM oauth_tokens WHERE household = ? AND client_id = ?").run(row.household, row.client_id);
        json(res, 400, { error: "invalid_grant" }); return true;
      }
      db.prepare("UPDATE oauth_tokens SET kind = 'used_refresh' WHERE hash = ?").run(h); // rotation: each refresh token works once
      issue(db, res, row.household, row.client_id);
      return true;
    }
    json(res, 400, { error: "unsupported_grant_type" });
    return true;
  }

  if (p === "/revoke" && req.method === "POST") {
    const f = new URLSearchParams(await readBody(req, 10_000));
    db.prepare("DELETE FROM oauth_tokens WHERE hash = ?").run(hash(f.get("token") ?? ""));
    res.writeHead(200, { "cache-control": "no-store" }).end(); // RFC 7009: always 200
    return true;
  }
  return false;
}

/** Remove expired rows; called periodically so the table cannot grow without bound. */
export function pruneTokens(db: DatabaseSync) {
  db.prepare("DELETE FROM oauth_tokens WHERE exp < ?").run(Date.now());
}

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---- rate limiting -------------------------------------------------------------------------------------
/** Fixed-window limiter. In-memory is right for one node; use a shared store (Redis, DynamoDB) behind a load balancer. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private max: number, private windowMs: number, private maxKeys = 50_000) {}
  /** Returns true if the call is allowed. */
  allow(key: string, now = Date.now()): boolean {
    const e = this.hits.get(key);
    if (!e || e.reset <= now) {
      if (this.hits.size >= this.maxKeys) this.sweep(now);
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    return ++e.n <= this.max;
  }
  retryAfter(key: string, now = Date.now()): number { return Math.max(1, Math.ceil(((this.hits.get(key)?.reset ?? now) - now) / 1000)); }
  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    if (this.hits.size >= this.maxKeys) this.hits.clear(); // fail open on memory pressure rather than grow without bound
  }
}

export function clientIp(req: IncomingMessage): string {
  if (process.env.HEARTH_TRUST_PROXY === "1") {
    const xf = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress ?? "unknown";
}

// ---- host / origin validation (DNS-rebinding and cross-site calls) ---------------------------------------
export function allowedHosts(publicUrl = process.env.PUBLIC_URL, port = process.env.PORT ?? "3939"): Set<string> {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "localhost", "127.0.0.1", "[::1]"]);
  if (publicUrl) { try { hosts.add(new URL(publicUrl).host); } catch { /* ignore bad PUBLIC_URL */ } }
  for (const h of (process.env.HEARTH_ALLOWED_HOSTS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) hosts.add(h);
  return hosts;
}
export function hostAllowed(req: IncomingMessage, hosts = allowedHosts()): boolean {
  return hosts.has(String(req.headers.host ?? "").toLowerCase());
}
/** Browser calls carry Origin; it must be this server or an explicitly allowed origin. Non-browser clients send none. */
export function originAllowed(req: IncomingMessage, hosts = allowedHosts()): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(String(origin));
    if (hosts.has(o.host.toLowerCase())) return true;
  } catch { return false; }
  return (process.env.HEARTH_ALLOWED_ORIGINS ?? "").split(",").map((x) => x.trim()).includes(String(origin));
}

// ---- response headers ----------------------------------------------------------------------------------
export const sha256b64 = (s: string) => createHash("sha256").update(s).digest("base64");

/** CSP for the simulator. The MCP App view runs inline in a sandboxed srcdoc iframe, so its script is allowed by hash only. */
export function csp(viewScriptHashes: string[]): string {
  return [
    "default-src 'none'",
    `script-src 'self' ${viewScriptHashes.map((h) => `'sha256-${h}'`).join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:", // the neural voice's audio is played from a blob the page builds
    "connect-src 'self'",
    "frame-src about:",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

export function securityHeaders(res: ServerResponse, contentSecurityPolicy?: string) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("permissions-policy", "camera=(), geolocation=(), payment=(), microphone=(self)");
  if (contentSecurityPolicy) res.setHeader("content-security-policy", contentSecurityPolicy);
}

/** Read a request body with a hard size cap (rejects instead of buffering without bound). */
export function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((ok, bad) => {
    let size = 0; const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > max) { bad(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    req.on("error", bad);
  });
}

/** Loopback or https only: refuses javascript:, data:, custom schemes and plain-http remote hosts. */
export function safeRedirectUri(u: string): boolean {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === "https:") return true;
    return x.protocol === "http:" && (x.hostname === "localhost" || x.hostname === "127.0.0.1" || x.hostname === "[::1]");
  } catch { return false; }
}

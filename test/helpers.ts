import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

export async function startServer(port: number, env: Record<string, string> = {}): Promise<{ proc: ChildProcess; base: string }> {
  // Node directly, not through npx: killing an npx wrapper does not stop the server it started on Linux, and a surviving server keeps the test run alive.
  const proc = spawn(process.execPath, ["--import", "tsx", "src/http.ts"], {
    env: { ...process.env, PORT: String(port), HEARTH_DB: ":memory:", HEARTH_RECALLS_OFFLINE: "1", HEARTH_RECALLS_SYNC: "off", HEARTH_RATE_REGISTER: "1000", HEARTH_RATE_TOKEN: "1000", HEARTH_RATE_AUTHORIZE: "1000", ...env },
    stdio: "pipe",
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return { proc, base }; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start");
}

export const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

export async function register(base: string, redirect = "http://localhost/cb"): Promise<string> {
  const r = await fetch(`${base}/register`, { method: "POST", body: JSON.stringify({ redirect_uris: [redirect], client_name: "test" }) });
  return ((await r.json()) as { client_id: string }).client_id;
}

/** GET the consent page and return its single-use nonce. */
export async function consentNonce(base: string, clientId: string, challenge: string, redirect = "http://localhost/cb", state = "s1"): Promise<string> {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state });
  const page = await (await fetch(`${base}/authorize?${q}`)).text();
  return page.match(/name=nonce value="([^"]+)"/)![1];
}

export async function approve(base: string, nonce: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/authorize`, { method: "POST", headers, body: new URLSearchParams({ nonce }), redirect: "manual" });
}

export interface Tokens { access_token: string; refresh_token: string; client_id: string }

/** Full account-linking dance; every call yields a brand-new household. */
export async function link(base: string): Promise<Tokens> {
  const redirect = "http://localhost/cb";
  const client_id = await register(base, redirect);
  const { verifier, challenge } = pkce();
  const nonce = await consentNonce(base, client_id, challenge, redirect);
  const res = await approve(base, nonce);
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const tok = (await (await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: redirect, code_verifier: verifier }) })).json()) as Tokens;
  return { ...tok, client_id };
}

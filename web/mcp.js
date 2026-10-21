// A small, honest MCP client for the browser: OAuth 2.1 + PKCE account linking,
// Streamable HTTP transport (JSON or SSE responses), session handling, and a wire log.

const PROTOCOL = "2025-11-25";
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

export class AuthRequired extends Error {}

export class McpClient {
  constructor(base, onWire = () => {}) {
    this.base = base;
    this.endpoint = `${base}/mcp`;
    this.onWire = onWire;
    this.nextId = 1;
    this.sessionId = null;
    this.tools = [];
    this.resources = new Map();
    this.server = null;
  }

  // ---- OAuth ---------------------------------------------------------------
  get token() { return store.get("hearth.token"); }

  async startLinking() {
    const prm = await (await fetch(`${this.base}/.well-known/oauth-protected-resource`)).json();
    const meta = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
    this.onWire({ dir: "meta", label: "discover authorization server", body: { issuer: meta.issuer, pkce: meta.code_challenge_methods_supported } });
    const redirect = `${location.origin}/`;
    const reg = await (await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: "Alexa+ simulator" }) })).json();
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
    store.set("hearth.oauth", JSON.stringify({ verifier, state, client_id: reg.client_id, token_endpoint: meta.token_endpoint, redirect }));
    const u = new URL(meta.authorization_endpoint);
    u.search = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, scope: "household" });
    location.assign(u);
  }

  async finishLinking(code, state) {
    const s = JSON.parse(store.get("hearth.oauth") || "null");
    store.del("hearth.oauth");
    if (!s || s.state !== state) throw new Error("Account linking state did not match. Start again.");
    const r = await fetch(s.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: s.client_id, redirect_uri: s.redirect, code_verifier: s.verifier }) });
    if (!r.ok) throw new Error("Account linking failed.");
    const t = await r.json();
    store.set("hearth.token", t.access_token);
    this.onWire({ dir: "meta", label: "token issued (PKCE verified)", body: { token_type: t.token_type, expires_in: t.expires_in, scope: t.scope } });
  }

  // ---- transport -----------------------------------------------------------
  async post(message, { expectResponse }) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    this.onWire({ dir: "out", body: message });
    const res = await fetch(this.endpoint, { method: "POST", headers, body: JSON.stringify(message) });
    if (res.status === 401) { store.del("hearth.token"); throw new AuthRequired("Account not linked"); }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!expectResponse) { await res.arrayBuffer().catch(() => {}); return null; }
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) return this.readStream(res, message.id);
    const body = await res.json();
    this.onWire({ dir: "in", body });
    return body;
  }

  async readStream(res, id) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const evt = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = evt.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const msg = JSON.parse(data);
        this.onWire({ dir: "in", body: msg });
        if (msg.id === id && (msg.result !== undefined || msg.error)) { reader.cancel().catch(() => {}); return msg; }
        if (msg.method && msg.id !== undefined) await this.answerServerRequest(msg);
      }
    }
    throw new Error("Stream ended without a response");
  }

  async answerServerRequest(msg) {
    // This simulator does not declare client capabilities that trigger server requests.
    await this.post({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not supported by this client" } }, { expectResponse: false });
  }

  async rpc(method, params) {
    const id = this.nextId++;
    const msg = await this.post({ jsonrpc: "2.0", id, method, params }, { expectResponse: true });
    if (msg.error) { const e = new Error(msg.error.message); e.code = msg.error.code; throw e; }
    return msg.result;
  }

  // ---- lifecycle -----------------------------------------------------------
  async connect() {
    if (!this.token) throw new AuthRequired("Account not linked");
    const init = await this.rpc("initialize", { protocolVersion: PROTOCOL, capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } }, clientInfo: { name: "hearth-alexa-simulator", version: "0.1.0" } });
    this.server = init;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, { expectResponse: false });
    this.tools = (await this.rpc("tools/list", {})).tools;
    return init;
  }

  async callTool(name, args = {}) { return this.rpc("tools/call", { name, arguments: args }); }

  uiUri(toolName) { return this.tools.find((t) => t.name === toolName)?._meta?.ui?.resourceUri ?? null; }

  async readUi(uri) {
    if (!this.resources.has(uri)) {
      const r = await this.rpc("resources/read", { uri });
      this.resources.set(uri, r.contents[0].text);
    }
    return this.resources.get(uri);
  }
}

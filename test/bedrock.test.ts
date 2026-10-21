import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Http2Server } from "node:http2"; // the AWS SDK speaks HTTP/2 to Bedrock, so the stand-in must too
import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { link, startServer, type Tokens } from "./helpers.js";

// The Bedrock path cannot be exercised against AWS in CI, so these tests put a stand-in Converse server behind the real
// HTTP endpoint and check what Hearth sends and enforces. Every bug found in the first live run is pinned here.

const CSV = readFileSync("data/sample-orders.csv", "utf8");
const FAKE_PORT = 3991, HEARTH_PORT = 3992;
interface Seen { url: string; auth: string | undefined; body: any }
const seen: Seen[] = [];
let fake: Http2Server, proc: ChildProcess, base = "", tok: Tokens;

before(async () => {
  fake = createServer((req, res) => {
    let b = ""; req.on("data", (c: Buffer) => (b += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(b || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: { message: { role: "assistant", content: [{ text: "You are low on dog food." }] } }, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 5 } }));
    });
  }).listen(FAKE_PORT);
  ({ proc, base } = await startServer(HEARTH_PORT, {
    HEARTH_AGENT: "bedrock", AWS_BEARER_TOKEN_BEDROCK: "test-token-not-real", AWS_REGION: "ap-southeast-2",
    BEDROCK_MODEL_ID: "au.anthropic.claude-haiku-4-5-20251001-v1:0", HEARTH_BEDROCK_ENDPOINT: `http://localhost:${FAKE_PORT}`, HEARTH_BEDROCK_DAILY_CALLS: "3",
  }));
  tok = await link(base);
});
after(() => { proc?.kill(); fake?.close(); });

const step = (token: string | null, body: unknown) => fetch(`${base}/api/agent/step`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const userMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const tools = [{ name: "household_runway", description: "forecast", inputSchema: { type: "object", properties: { withinDays: { type: "number" } } } }];

test("status reports the Bedrock brain and model without leaking credentials", async () => {
  const s = (await (await fetch(`${base}/api/agent/status`)).json()) as Record<string, unknown>;
  assert.deepEqual([s.mode, s.model, s.region], ["bedrock", "au.anthropic.claude-haiku-4-5-20251001-v1:0", "ap-southeast-2"]);
  assert.ok(!JSON.stringify(s).includes("test-token"));
});

test("the model endpoint refuses callers without a token, and the model is never reached", async () => {
  const before = seen.length;
  assert.equal((await step(null, { messages: [userMsg("hi")], tools })).status, 401);
  assert.equal(seen.length, before, "an unauthenticated request must not spend a model call");
});

test("an authenticated step reaches Bedrock in the right shape and returns the model's reply", async () => {
  const r = await step(tok.access_token, { messages: [userMsg("what is low?")], tools });
  assert.equal(r.status, 200);
  const out = (await r.json()) as { role: string; content: { type: string; text?: string }[] };
  assert.deepEqual([out.role, out.content[0].type, out.content[0].text], ["assistant", "text", "You are low on dog food."]);
  const call = seen[seen.length - 1];
  assert.match(call.url, /\/model\/au\.anthropic\.claude-haiku-4-5-20251001-v1%3A0\/converse$|\/model\/au\.anthropic\.claude-haiku-4-5-20251001-v1:0\/converse$/);
  assert.equal(call.auth, "Bearer test-token-not-real", "uses the Bedrock API key from the environment, server side only");
  assert.equal(call.body.toolConfig.tools[0].toolSpec.name, "household_runway");
  assert.match(call.body.system[0].text, /spoken aloud/);
  assert.ok(call.body.inferenceConfig.maxTokens <= 400, "replies are kept short and cheap");
});

test("the model is told how to use assistant-only ids, and the browser's local fields never reach it", async () => {
  const agent = await import("../web/agent.js" as string) as { remoteStep: (m: unknown[], t: unknown[], token: string) => Promise<unknown> };
  const captured: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => { captured.push({ url, init }); return new Response(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "ok" }] }), { status: 200 }); }) as typeof fetch;
  try {
    await agent.remoteStep([
      userMsg("plan it"),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "plan_restock", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", text: "Here is a plan.", modelText: "Here is a plan.\n[for the assistant] {\"proposalId\":\"prop_abc123\"}", structured: { secretUiState: 1 } }] },
    ], tools, "tok-123");
  } finally { globalThis.fetch = realFetch; }
  const sent = captured[0];
  assert.equal((sent.init.headers as Record<string, string>).authorization, "Bearer tok-123", "bug 1: the token must accompany every model step");
  const body = JSON.parse(String(sent.init.body));
  const result = body.messages[2].content[0];
  assert.match(result.text, /prop_abc123/, "bug 3: the model must receive the id it needs to confirm");
  assert.ok(!("structured" in result) && !JSON.stringify(body).includes("secretUiState"), "UI-only fields stay in the browser");
});

test("tool results carry the ids the model needs in an assistant-only block, never in the spoken one", async () => {
  const c = new Client({ name: "ids", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
  await c.callTool({ name: "import_order_history", arguments: { csv: CSV } });
  const blocks = (r: unknown) => (r as { content: { text: string; annotations?: { audience?: string[] } }[] }).content;
  const plan = await c.callTool({ name: "plan_restock", arguments: { withinDays: 14, budget: 60 } });
  const id = (plan as any).structuredContent.proposal.id as string;
  assert.ok(!blocks(plan)[0].text.includes(id), "the spoken block never contains an id");
  assert.deepEqual(blocks(plan)[1].annotations?.audience, ["assistant"]);
  assert.ok(blocks(plan)[1].text.includes(id) && /confirm_restock/.test(blocks(plan)[1].text));
  const done = await c.callTool({ name: "confirm_restock", arguments: { proposalId: id, userConfirmed: true } });
  assert.ok(blocks(done)[1].text.includes(id) && /undo_restock/.test(blocks(done)[1].text) && blocks(done)[1].text.includes("SIM-"));
  const run = await c.callTool({ name: "household_runway", arguments: {} });
  assert.match(blocks(run)[1].text, /"productKey":"asin:/);
  await c.close();
});

test("the daily model-call cap is enforced by the live endpoint", async () => {
  // earlier tests used 1 call; the cap is 3 per day
  const a = await step(tok.access_token, { messages: [userMsg("one")], tools });
  const b = await step(tok.access_token, { messages: [userMsg("two")], tools });
  const c = await step(tok.access_token, { messages: [userMsg("three")], tools });
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 429]);
  assert.match(((await c.json()) as { error: string }).error, /Daily model-call limit/);
  const calls = seen.length;
  await step(tok.access_token, { messages: [userMsg("four")], tools });
  assert.equal(seen.length, calls, "past the cap nothing reaches the model");
});

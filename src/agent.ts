import type { DatabaseSync } from "node:sqlite";
import { BedrockRuntimeClient, ConverseCommand, type Message, type ContentBlock, type Tool } from "@aws-sdk/client-bedrock-runtime";

// Server-side brain for the simulated Alexa+: Claude on Amazon Bedrock (Converse API with tool use).
// The browser stays the real MCP client — it executes every tool call and sends results back.

export const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
export const REGION = process.env.AWS_REGION ?? "us-east-1";

export const SYSTEM = [
  "You are Alexa+ speaking in a kitchen. Replies are spoken aloud: one or two short sentences, no markdown, no lists.",
  "You have Hearth tools that remember the household's purchases. Use them instead of guessing.",
  "Details appear on the screen as cards, so do not read them out; summarize what matters.",
  "Never place an order unless the user has just clearly agreed to a specific plan you described. Always plan_restock first, then ask.",
  "If a tool returns an error, say what went wrong in plain words and what the user can do next.",
].join(" ");

export interface WireBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; isError?: boolean;
}
export interface WireMessage { role: "user" | "assistant"; content: WireBlock[] }
export interface WireTool { name: string; description?: string; inputSchema: unknown }

export function hasBedrockCredentials(env = process.env): boolean {
  if (env.HEARTH_AGENT === "local") return false;
  return Boolean(env.HEARTH_AGENT === "bedrock" || env.AWS_BEARER_TOKEN_BEDROCK || env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI);
}

export function toConverse(messages: WireMessage[]): Message[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b): ContentBlock => {
      if (b.type === "text") return { text: b.text || " " };
      if (b.type === "tool_use") return { toolUse: { toolUseId: b.id!, name: b.name!, input: (b.input ?? {}) as Record<string, never> } };
      return { toolResult: { toolUseId: b.tool_use_id!, content: [{ text: b.text || "(empty)" }], status: b.isError ? "error" : "success" } };
    }),
  }));
}

export function toTools(tools: WireTool[]): Tool[] {
  return tools.map((t) => ({ toolSpec: { name: t.name, description: t.description ?? "", inputSchema: { json: t.inputSchema as never } } }));
}

export function fromConverse(msg: Message | undefined): WireMessage {
  const content: WireBlock[] = [];
  for (const b of msg?.content ?? []) {
    if (b.text) content.push({ type: "text", text: b.text });
    else if (b.toolUse) content.push({ type: "tool_use", id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input });
  }
  return { role: "assistant", content };
}

export interface Converser { send(cmd: ConverseCommand): Promise<{ output?: { message?: Message } }> }

export async function bedrockStep(client: Converser, messages: WireMessage[], tools: WireTool[], modelId = MODEL_ID): Promise<WireMessage> {
  const out = await client.send(new ConverseCommand({
    modelId,
    system: [{ text: SYSTEM }],
    messages: toConverse(messages),
    toolConfig: tools.length ? { tools: toTools(tools) } : undefined,
    inferenceConfig: { maxTokens: 400, temperature: 0.2 },
  }));
  return fromConverse(out.output?.message);
}

let shared: BedrockRuntimeClient | undefined;
export const bedrockClient = (): Converser => (shared ??= new BedrockRuntimeClient({ region: REGION }));

/** Strict shape check for /api/agent/step: bounded size, known block types, sane tool names. Returns an error string or null. */
export function validateAgentRequest(body: unknown): string | null {
  const b = body as { messages?: unknown; tools?: unknown } | null;
  if (!b || !Array.isArray(b.messages) || !Array.isArray(b.tools)) return "messages and tools are required";
  if (b.messages.length === 0 || b.messages.length > 40) return "between 1 and 40 messages";
  if (b.tools.length > 20) return "at most 20 tools";
  let size = 0;
  for (const m of b.messages as WireMessage[]) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || !Array.isArray(m.content) || m.content.length > 50) return "malformed message";
    for (const blk of m.content) {
      if (!blk || !["text", "tool_use", "tool_result"].includes(blk.type)) return "unknown content block";
      if (blk.text !== undefined && (typeof blk.text !== "string" || blk.text.length > 20_000)) return "text too long";
      if (blk.type === "tool_use" && (typeof blk.name !== "string" || !/^[\w-]{1,64}$/.test(blk.name) || typeof blk.id !== "string" || blk.id.length > 100)) return "malformed tool_use";
      if (blk.type === "tool_result" && (typeof blk.tool_use_id !== "string" || blk.tool_use_id.length > 100)) return "malformed tool_result";
      size += JSON.stringify(blk).length;
    }
  }
  if (size > 200_000) return "conversation too large";
  for (const t of b.tools as WireTool[]) {
    if (!t || typeof t.name !== "string" || !/^[\w-]{1,64}$/.test(t.name) || (t.description !== undefined && String(t.description).length > 2000) || typeof t.inputSchema !== "object") return "malformed tool";
  }
  return null;
}

/**
 * Free-plan guard: every model call is counted per UTC day in the database and refused past the cap, so a loop,
 * a bug or an abusive client can never run up a bill. The cap survives restarts. Default 150 calls/day
 * (roughly a dollar or less of Sonnet-class usage at this app's request sizes); override with HEARTH_BEDROCK_DAILY_CALLS.
 */
export function reserveBedrockCall(db: DatabaseSync, max = Number(process.env.HEARTH_BEDROCK_DAILY_CALLS ?? 150), now = Date.now()): { ok: boolean; used: number; max: number } {
  const key = `bedrock_calls:${new Date(now).toISOString().slice(0, 10)}`;
  db.prepare("DELETE FROM prefs WHERE household = '_system' AND key LIKE 'bedrock_calls:%' AND key != ?").run(key);
  const row = db.prepare("SELECT value FROM prefs WHERE household = '_system' AND key = ?").get(key) as { value: string } | undefined;
  const used = Number(row?.value ?? 0);
  if (used >= max) return { ok: false, used, max };
  db.prepare("INSERT OR REPLACE INTO prefs (household, key, value) VALUES ('_system', ?, ?)").run(key, String(used + 1));
  return { ok: true, used: used + 1, max };
}

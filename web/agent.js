// The "brain" of the simulated Alexa+. Same contract either way: given the conversation
// so far, return the next assistant message (text and/or tool_use blocks).
//   - Bedrock mode: the server runs Claude on Amazon Bedrock (see src/agent.ts).
//   - Offline mode: a small deterministic intent router, so the demo works with no AWS account.

export async function agentMode() {
  try { return (await (await fetch("/api/agent/status")).json()).mode; } catch { return "local"; }
}

/** The model endpoint is authenticated (it spends money), so the same bearer token as /mcp must accompany every step. */
export async function remoteStep(messages, tools, token) {
  const r = await fetch("/api/agent/step", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ messages: messages.map(toWire), tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Agent error ${r.status}`);
  return r.json();
}

/** Local-only fields (structured results, UI state) never leave the browser; the model gets text, plus assistant-only data for tool results. */
function toWire(m) {
  return { role: m.role, content: m.content.map((b) => (b.type === "tool_result" ? { type: b.type, tool_use_id: b.tool_use_id, isError: b.isError, text: b.modelText ?? b.text } : b)) };
}

/** Keep the last turns without splitting a tool call from its result (mirrors src/agent.ts; both are tested). */
export function trimConversation(messages, max = 24) {
  if (messages.length <= max) return messages;
  const isTurnStart = (m) => m.role === "user" && m.content.some((b) => b.type === "text") && !m.content.some((b) => b.type === "tool_result");
  for (let i = messages.length - max; i < messages.length; i++) if (isTurnStart(messages[i])) return messages.slice(i);
  for (let i = messages.length - max - 1; i >= 0; i--) if (isTurnStart(messages[i])) return messages.slice(i);
  return messages.slice(-max);
}

/** A model that has nothing to add after a tool call returns an empty reply. Speak the tool's own sentence instead of silence. */
export function ensureSpoken(reply, fallback) {
  const hasCall = reply.content.some((b) => b.type === "tool_use");
  const text = reply.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
  if (hasCall || text) return reply;
  return { role: "assistant", content: [{ type: "text", text: fallback || "Okay." }] };
}

export function describeItem(i) {
  const when = i.daysLeft < 0 ? `by your usual pace it ran out about ${-i.daysLeft} days ago` : i.daysLeft === 0 ? "it runs out today" : `about ${i.daysLeft} days left`;
  return `${i.name}: ${when}, give or take ${i.windowDays}. ${i.confidence} confidence, from ${i.purchases} orders.`;
}

const money = (t) => { const m = t.match(/\$\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:dollars|bucks)/i); return m ? Number(m[1] ?? m[2]) : null; };
const days = (t) => { const m = t.match(/(\d+)\s*(day|week)/i); return m ? Number(m[1]) * (/week/i.test(m[2]) ? 7 : 1) : null; };

function lastStructured(messages, view) {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const b of messages[i].content ?? []) if (b.type === "tool_result" && b.structured?.view === view) return b.structured;
  }
  return null;
}

export function localStep(messages, { sampleCsv }) {
  const last = messages[messages.length - 1];
  const results = last.content.filter((b) => b.type === "tool_result");
  if (results.length) {
    return { role: "assistant", content: [{ type: "text", text: results.map((r) => r.text).join(" ") }] };
  }
  const text = last.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
  const t = text.toLowerCase();
  const call = (name, input) => ({ role: "assistant", content: [{ type: "tool_use", id: `local_${Math.random().toString(36).slice(2, 9)}`, name, input }] });
  const say = (s) => ({ role: "assistant", content: [{ type: "text", text: s }] });

  // Conversational follow-ups that rely on what was just said (the offline router's version of "context").
  if (/^(no|nope|no thanks|that's all|that is all|nothing else|never ?mind)\b/.test(t)) return say("Okay. Say Alexa whenever you need me.");
  if (/\b(thanks|thank you|cheers)\b/.test(t)) return say("You're welcome.");
  const runway = lastStructured(messages, "runway");
  if (runway && !/\b(order|restock|plan|buy|undo|cancel|recall|load|import|budget)\w*/.test(t)) {
    const item = (runway.items ?? []).find((i) => i.name.toLowerCase().split(/\s+/).some((w) => w.length >= 4 && new RegExp(`\\b${w}\\b`).test(t)));
    if (item) return say(describeItem(item));
  }
  const lang = t.match(/\b(spanish|español|espanol|hindi|हिन्दी|english)\b/);
  if (lang && /\b(speak|talk|switch|reply|respond|habla|बात|in)\b/.test(t)) return call("remember_preference", { kind: "language", value: /span|espa/.test(lang[1]) ? "es" : /hindi|हिन्दी/.test(lang[1]) ? "hi" : "en" });
  if (/\b(load|import|sample|history|upload)\w*/.test(t)) return call("import_order_history", { csv: sampleCsv });
  if (/\b(new recall|recall alert|any alerts?|just recalled)\w*/.test(t)) return call("recall_alerts", {});
  if (/\b(recall|unsafe|safe|dangerous|burn|hazard)\w*/.test(t)) return call("check_recalls", {});
  if (/\b(undo|cancel)\w*/.test(t)) {
    const r = lastStructured(messages, "receipt");
    return r ? call("undo_restock", { proposalId: r.proposalId }) : say("There's no recent order for me to cancel.");
  }
  if (/\b(yes|yeah|yep|place it|go ahead|do it|confirm|order it|sounds good)\w*/.test(t)) {
    const p = lastStructured(messages, "proposal");
    return p ? call("confirm_restock", { proposalId: p.proposal.id, userConfirmed: true }) : say("I don't have a plan waiting. Want me to put one together?");
  }
  if (/^(keep|stay|set|cap|limit)\b/.test(t) && money(t)) return call("remember_preference", { kind: "budget_usd", value: String(money(t)) });
  if (/\b(order|restock|buy|reorder|plan|stock up|cart)\w*/.test(t)) return call("plan_restock", { withinDays: days(t) ?? 14, ...(money(t) ? { budgetUsd: money(t) } : {}) });
  if (/\b(keep|stay|budget|cap)\w*/.test(t) && money(t)) return call("remember_preference", { kind: "budget_usd", value: String(money(t)) });
  if (/\b(log|done|did you|activity|audit)\w*/.test(t)) return call("activity_log", { limit: 10 });
  if (/\b(low|running|out|runway|stock|left|need|pantry|supplies|soon)\w*/.test(t)) return call("household_runway", { withinDays: days(t) ?? 30 });
  return say("I can tell you what's running low, check your appliances for recalls, or put together a restock. What would you like?");
}

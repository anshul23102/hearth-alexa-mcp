import { McpClient, AuthRequired } from "./mcp.js";
import { mountApp } from "./appHost.js";
import { agentMode, remoteStep, localStep } from "./agent.js";

const $ = (id) => document.getElementById(id);
const shell = $("shell"), say = $("say"), heard = $("heard"), lightbar = $("lightbar"), paper = $("paper"), blank = $("blank");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- wire log ---------------------------------------------------------------
let wireN = 0;
function wire({ dir, body, label }) {
  wireN++;
  $("wireCount").textContent = `${wireN} message${wireN === 1 ? "" : "s"}`;
  const li = document.createElement("li");
  li.dataset.dir = dir;
  const arrow = { out: "→", in: "←", app: "◇", meta: "·" }[dir] ?? "·";
  const name = label ?? (body.method ? body.method : body.error ? `error ${body.error.code}` : body.result?.tools ? `result · ${body.result.tools.length} tools` : body.result?.serverInfo ? "result · initialize" : "result");
  const extra = body.params?.name ? ` ${body.params.name}` : "";
  const head = document.createElement("div");
  const ar = Object.assign(document.createElement("span"), { className: "ar", textContent: arrow });
  const nm = Object.assign(document.createElement("span"), { className: "nm", textContent: name + extra });
  const tm = Object.assign(document.createElement("time"), { textContent: new Date().toLocaleTimeString([], { hour12: false }) });
  head.append(ar, nm, tm);
  const pre = document.createElement("pre");
  const text = JSON.stringify(body, null, 1);
  pre.textContent = text.length > 2400 ? text.slice(0, 2400) + "\n… (" + text.length + " chars)" : text;
  li.append(head, pre);
  const log = $("wireLog");
  log.append(li);
  log.scrollTop = log.scrollHeight;
}
$("wireToggle").addEventListener("click", () => {
  const open = $("wire").dataset.open !== "true";
  $("wire").dataset.open = String(open);
  $("wireToggle").setAttribute("aria-expanded", String(open));
});

// ---- ui helpers -------------------------------------------------------------
const setState = (s) => { lightbar.dataset.state = s; };
const setStatus = (kind, text) => {
  const dot = Object.assign(document.createElement("i"), { className: `dot ${kind}`.trim() });
  $("status").replaceChildren(dot, document.createTextNode(text));
};
let typing = 0;
async function speak(text) {
  const id = ++typing;
  say.textContent = "";
  if (reduce) { say.textContent = text; return; }
  setState("speaking");
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    if (id !== typing) return;
    say.textContent += (i ? " " : "") + words[i];
    await new Promise((r) => setTimeout(r, 28 + Math.min(words[i].length, 8) * 6));
  }
  if (id === typing) setState("idle");
  if (ttsOn) tts(text);
}
let ttsOn = false;
function tts(text) { try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch { /* unsupported */ } }

// ---- boot -------------------------------------------------------------------
const mcp = new McpClient(location.origin, wire);
let messages = [];
let busy = false;
let sampleCsv = "";
let brain = "local";

const SUGGEST = ["What are we running low on?", "Any recalls on what we own?", "Plan a restock under $60", "Keep restocks under $80", "Speak Spanish"];

function phase(p) { shell.dataset.phase = p; }
function showChips() {
  const c = $("chips");
  c.hidden = false;
  c.replaceChildren(...SUGGEST.map((s) => { const b = document.createElement("button"); b.type = "button"; b.textContent = s; b.addEventListener("click", () => ask(s)); return b; }));
}

async function boot() {
  const p = new URLSearchParams(location.search);
  if (p.get("code")) {
    try { await mcp.finishLinking(p.get("code"), p.get("state")); } catch (e) { speak(e.message); }
    history.replaceState({}, "", "/");
  }
  brain = await agentMode();
  try {
    const init = await mcp.connect();
    $("proto").textContent = `MCP ${init.protocolVersion}`;
    setStatus("ok", `Linked · ${init.serverInfo.name} ${init.serverInfo.version} · ${brain === "bedrock" ? "Claude on Amazon Bedrock" : "offline router"}`);
    $("forget").hidden = false;
    const r = await mcp.callTool("household_runway", { withinDays: 30 });
    if (r.structuredContent?.items?.length) { ready(); speak("Welcome back. I remember your household. Ask me what's running low."); }
    else {
      phase("load");
      speak("I'm linked, but I don't know your household yet. Load your order history and I'll learn how fast you use things.");
      $("loadStep").hidden = false;
    }
  } catch (e) {
    if (e instanceof AuthRequired) {
      phase("link");
      setStatus("", "Not linked");
      speak("Hi, I'm Alexa+. To remember your household I need to link Hearth to your account.");
      $("linkStep").hidden = false;
    } else { setStatus("bad", "Server unreachable"); speak("I can't reach the Hearth server. Is it running?"); console.error(e); }
  }
}
function ready() {
  phase("ready");
  $("loadStep").hidden = true;
  $("askForm").hidden = false;
  showChips();
}

$("linkBtn").addEventListener("click", () => mcp.startLinking());
$("forget").addEventListener("click", async () => {
  if (!confirm("Erase all of this household's data from Hearth and sign out? This cannot be undone.")) return;
  try { const r = await mcp.callTool("delete_household_data", { confirm: "DELETE MY DATA" }); if (r.isError) throw new Error(r.content?.[0]?.text); } catch (e) { speak(`I couldn't erase it: ${e.message}`); return; }
  try { sessionStorage.clear(); } catch { /* private mode */ }
  location.assign("/");
});
$("loadBtn").addEventListener("click", async () => {
  $("loadBtn").disabled = true;
  sampleCsv = sampleCsv || await (await fetch("/demo/sample-orders.csv")).text();
  await ask("Load my order history", { quiet: false });
  ready();
});

// ---- the loop ---------------------------------------------------------------
async function ask(text, opts = {}) {
  if (busy || !text.trim()) return;
  busy = true;
  heard.textContent = `“${text.trim()}”`;
  $("ask").value = "";
  setState("thinking");
  if (!sampleCsv && /\b(load|import|history|sample|upload)\b/i.test(text)) sampleCsv = await (await fetch("/demo/sample-orders.csv")).text();
  messages.push({ role: "user", content: [{ type: "text", text }] });
  try {
    for (let hop = 0; hop < 6; hop++) {
      const reply = brain === "bedrock" ? await remoteStep(messages, mcp.tools) : localStep(messages, { sampleCsv });
      messages.push(reply);
      const calls = reply.content.filter((b) => b.type === "tool_use");
      if (!calls.length) { await speak(reply.content.filter((b) => b.type === "text").map((b) => b.text).join(" ")); break; }
      const results = [];
      for (const c of calls) {
        setState("thinking");
        let r;
        try { r = await mcp.callTool(c.name, c.input); } catch (e) { r = { isError: true, content: [{ type: "text", text: e.message }] }; }
        const spoken = r.content?.[0]?.text ?? "";
        results.push({ type: "tool_result", tool_use_id: c.id, text: spoken, isError: !!r.isError, structured: r.structuredContent });
        await showCard(c.name, c.input, r);
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    console.error(e);
    await speak(`Sorry, something went wrong: ${e.message}`);
  } finally { busy = false; setState("idle"); }
}

async function showCard(name, args, result) {
  const uri = mcp.uiUri(name);
  if (!uri || !result.structuredContent || result.isError) return;
  const html = await mcp.readUi(uri);
  blank.hidden = true;
  const wrap = document.createElement("div");
  wrap.className = "sheet";
  const frame = mountApp({
    html, mcp, toolName: name, args, result,
    // The user can press buttons inside a card; fold that back into the conversation.
    onToolResult: (tool, a, r) => {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `ui_${Date.now()}`, text: r.content?.[0]?.text ?? "", isError: !!r.isError, structured: r.structuredContent }] });
      messages.push({ role: "assistant", content: [{ type: "text", text: r.content?.[0]?.text ?? "" }] });
      heard.textContent = tool === "confirm_restock" ? "(pressed Place order)" : "(pressed Cancel order)";
      speak(r.content?.[0]?.text ?? "");
    },
  });
  wrap.append(frame);
  paper.prepend(wrap);
  $("led").classList.add("on");
  setTimeout(() => $("led").classList.remove("on"), 900);
  paper.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}

$("askForm").addEventListener("submit", (e) => { e.preventDefault(); ask($("ask").value); });

// ---- voice (optional, progressive) --------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  const mic = $("mic");
  mic.hidden = false;
  const rec = new SR(); rec.lang = "en-US"; rec.interimResults = false;
  rec.onresult = (e) => ask(e.results[0][0].transcript);
  rec.onend = () => { mic.setAttribute("aria-pressed", "false"); if (!busy) setState("idle"); };
  mic.addEventListener("click", () => { ttsOn = true; mic.setAttribute("aria-pressed", "true"); setState("listening"); try { rec.start(); } catch { /* already started */ } });
}

boot();

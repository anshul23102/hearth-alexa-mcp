import { McpClient, AuthRequired } from "./mcp.js";
import { mountApp } from "./appHost.js";
import { agentMode, remoteStep, localStep, ensureSpoken, trimConversation } from "./agent.js";
import { speakAloud, stopSpeaking, detectLang, chime } from "./speech.js";
import { createVoice } from "./voice.js";

const $ = (id) => document.getElementById(id);
const say = $("say"), heard = $("heard"), lightbar = $("lightbar"), paper = $("paper"), blank = $("blank");
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
// Replies are shown word by word and, when voice replies are on, spoken at the same time; the promise resolves when both finish,
// so the microphone can re-open for a follow-up exactly when Alexa stops talking.
let voiceReplies = store("hearth.voiceReplies") === "1";
const voiceLang = () => $("vlang").value;
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } }

async function type(text, id) {
  say.textContent = "";
  if (reduce) { say.textContent = text; return; }
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    if (id !== typing) return;
    say.textContent += (i ? " " : "") + words[i];
    await new Promise((r) => setTimeout(r, 28 + Math.min(words[i].length, 8) * 6));
  }
}
async function speak(text) {
  const id = ++typing;
  setState("speaking");
  const talk = voiceReplies && text.trim() ? speakAloud(text, detectLang(text, voiceLang())) : Promise.resolve();
  await Promise.all([type(text, id), talk]);
  if (id === typing && !busy) setState("idle");
}

// ---- boot -------------------------------------------------------------------
const mcp = new McpClient(location.origin, wire);
let messages = [];
let busy = false;
let sampleCsv = "";
let brain = "local";

const SUGGEST = ["What are we running low on?", "Any recalls on what we own?", "Plan a restock under $60", "Keep restocks under $80", "Speak Spanish"];

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
    subscribeToAlerts();
    const r = await mcp.callTool("household_runway", { withinDays: 30 });
    if (r.structuredContent?.items?.length) { ready(); speak("Welcome back. I remember your household. Ask me what's running low."); }
    else {
      speak("I'm linked, but I don't know your household yet. Load your order history and I'll learn how fast you use things.");
      $("loadStep").hidden = false;
    }
  } catch (e) {
    if (e instanceof AuthRequired) {
      setStatus("", "Not linked");
      speak("Hi, I'm Alexa+. To remember your household I need to link Hearth to your account.");
      $("linkStep").hidden = false;
    } else { setStatus("bad", "Server unreachable"); speak("I can't reach the Hearth server. Is it running?"); console.error(e); }
  }
}
function ready() {
  $("loadStep").hidden = true;
  $("askForm").hidden = false;
  $("voicebar").hidden = !voiceUsable;
  showChips();
}

$("linkBtn").addEventListener("click", () => mcp.startLinking());
$("forget").addEventListener("click", async () => {
  if (!confirm("Erase all of this household's data from Hearth and sign out? This cannot be undone.")) return;
  try { const r = await mcp.callTool("delete_household_data", { confirm: "DELETE MY DATA" }); if (r.isError) throw new Error(r.content?.[0]?.text); } catch (e) { speak(`I couldn't erase it: ${e.message}`); return; }
  try { sessionStorage.clear(); } catch { /* private mode */ }
  location.assign("/");
});
// A button press is a host action, not a question: call the import tool directly, whatever the brain is.
// (With the Bedrock brain the model never sees the file, and 40 KB of CSV should not pass through a model anyway.)
const MAX_INLINE_CSV = 4 * 1024 * 1024; // larger exports go through the streaming upload endpoint
async function importCsv(label, getText) {
  $("loadBtn").disabled = $("fileBtn").disabled = true;
  heard.textContent = `(loaded ${label})`;
  setState("thinking");
  try {
    const text = await getText();
    const r = await mcp.callTool("import_order_history", { csv: text });
    const reply = r.content?.[0]?.text ?? "";
    messages.push({ role: "user", content: [{ type: "text", text: "I loaded my order history." }] }, { role: "assistant", content: [{ type: "text", text: reply }] });
    await speak(reply);
    ready();
  } catch (e) {
    $("loadBtn").disabled = $("fileBtn").disabled = false;
    await speak(e instanceof AuthRequired ? "Your session expired. Reload the page to link again." : `I couldn't load that: ${e.message}`);
  } finally { setState("idle"); }
}
$("loadBtn").addEventListener("click", () => {
  const file = $("sampleSel").value;
  importCsv("the sample order history", async () => (sampleCsv = await (await fetch(`/demo/${file}`)).text()));
});
$("fileBtn").addEventListener("click", () => $("fileIn").click());
$("fileIn").addEventListener("change", () => {
  const f = $("fileIn").files[0];
  $("fileIn").value = "";
  if (!f) return;
  if (f.size > MAX_INLINE_CSV) { speak("That file is larger than 4 megabytes. Upload big exports with the import API; see the README."); return; }
  importCsv(f.name, () => f.text());
});

// ---- proactive recall alerts (MCP resource subscription) ------------------------------------------------
let alertQueued = false;
async function subscribeToAlerts() {
  try { await mcp.rpc("resources/subscribe", { uri: "hearth://alerts" }); } catch { return; } // older servers: no push, pull still works
  mcp.listen((msg) => {
    if (msg.method === "notifications/resources/updated" && msg.params?.uri === "hearth://alerts") showAlert();
  });
}
async function showAlert() {
  if (busy) { alertQueued = true; return; }
  busy = true;
  voice.pause();
  try {
    const r = await mcp.callTool("recall_alerts", {});
    const text = r.content?.[0]?.text ?? "";
    const bar = $("alertbar");
    bar.textContent = "New recall for something you own";
    bar.hidden = false;
    setTimeout(() => { bar.hidden = true; }, 20000);
    heard.textContent = "(new recall alert, pushed by the server)";
    await showCard("recall_alerts", {}, r);
    messages.push({ role: "assistant", content: [{ type: "text", text }] });
    await speak(text);
  } catch (e) { console.error(e); } finally { busy = false; setState("idle"); if (alertQueued) { alertQueued = false; showAlert(); } else voice.afterReply(); }
}

// ---- the loop ---------------------------------------------------------------
let pending = null;
async function ask(text, opts = {}) {
  if (!text.trim()) return;
  if (busy) { pending = text; return; }   // said while Alexa was still working: answer it next, never drop it
  busy = true;
  voice.pause();                          // she must not hear herself
  stopSpeaking();
  heard.textContent = `“${text.trim()}”`;
  $("ask").value = "";
  setState("thinking");
  if (!sampleCsv && /\b(load|import|history|sample|upload)\b/i.test(text)) sampleCsv = await (await fetch("/demo/sample-orders.csv")).text();
  messages.push({ role: "user", content: [{ type: "text", text }] });
  try {
    let lastSpoken = "";
    for (let hop = 0; hop < 6; hop++) {
      const raw = brain === "bedrock" ? await remoteStep(trimConversation(messages), mcp.tools, mcp.token) : localStep(messages, { sampleCsv });
      const reply = ensureSpoken(raw, lastSpoken);
      messages.push(reply);
      const calls = reply.content.filter((b) => b.type === "tool_use");
      if (!calls.length) { await speak(reply.content.filter((b) => b.type === "text").map((b) => b.text).join(" ")); break; }
      const results = [];
      for (const c of calls) {
        setState("thinking");
        let r;
        try { r = await mcp.callTool(c.name, c.input); } catch (e) { r = { isError: true, content: [{ type: "text", text: e.message }] }; }
        const spoken = r.content?.[0]?.text ?? "";
        // The model also gets any assistant-audience blocks (ids it needs next); only the first block is ever spoken or shown.
        const modelText = modelTextOf(r);
        results.push({ type: "tool_result", tool_use_id: c.id, text: spoken, modelText, isError: !!r.isError, structured: r.structuredContent });
        await showCard(c.name, c.input, r);
      }
      lastSpoken = results.map((x) => x.text).filter(Boolean).join(" ");
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    console.error(e);
    await speak(`Sorry, something went wrong: ${e.message}`);
  } finally {
    busy = false; setState("idle");
    if (pending) { const next = pending; pending = null; ask(next); } else voice.afterReply();
  }
}

/** Assistant-audience blocks (ids the model needs next) plus the spoken sentence; used for the model only. */
function modelTextOf(r) {
  return (r.content ?? []).filter((b) => b.type === "text" && (b.annotations?.audience ?? ["user", "assistant"]).includes("assistant")).map((b) => b.text).join("\n");
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
      const id = `ui_${Date.now()}`, spoken = r.content?.[0]?.text ?? "";
      const label = tool === "confirm_restock" ? "Place order" : tool === "undo_restock" ? "Cancel order" : tool;
      // A complete, valid turn (question, call, result, answer): an orphaned tool result would make the next model call fail.
      messages.push(
        { role: "user", content: [{ type: "text", text: `(I pressed “${label}” on the card.)` }] },
        { role: "assistant", content: [{ type: "tool_use", id, name: tool, input: a }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, text: spoken, modelText: modelTextOf(r), isError: !!r.isError, structured: r.structuredContent }] },
        { role: "assistant", content: [{ type: "text", text: spoken }] },
      );
      heard.textContent = `(pressed ${label})`;
      speak(spoken);
    },
  });
  wrap.append(frame);
  paper.prepend(wrap);
  $("led").classList.add("on");
  setTimeout(() => $("led").classList.remove("on"), 900);
  paper.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}

$("askForm").addEventListener("submit", (e) => { e.preventDefault(); ask($("ask").value); });

// ---- voice: a spoken conversation ------------------------------------------------------------------------------
// Mic button or "Say Alexa" opens a conversation; after each spoken reply the mic re-opens for a follow-up, silence ends it.
const voice = createVoice({
  getLang: voiceLang,
  onCommand: (t) => ask(t),
  onWake: () => { chime(); setState("listening"); },
  onState: (s) => {
    $("mic").setAttribute("aria-pressed", String(s === "listening"));
    $("hands").setAttribute("aria-pressed", String(voice.hands));
    if (s === "listening") setState("listening");
    else if (s === "blocked") { $("hands").setAttribute("aria-pressed", "false"); speak("The microphone is blocked. Allow it for this site in your browser settings, then try again."); }
    else if (!busy) setState("idle");
  },
});

let voiceUsable = false;   // the bar itself appears once the household is ready (see ready())
function setupVoiceControls() {
  const hasSpeech = "speechSynthesis" in window;
  if (!hasSpeech && !voice.supported) return;
  voiceUsable = true;
  const pref = store("hearth.vlang");
  const nav = (navigator.language || "en-US");
  $("vlang").value = [...$("vlang").options].some((o) => o.value === (pref || nav)) ? (pref || nav) : nav.startsWith("hi") ? "hi-IN" : nav.startsWith("es") ? "es-MX" : "en-US";
  $("vlang").addEventListener("change", async () => {
    store("hearth.vlang", voiceLang());
    const code = voiceLang().slice(0, 2); // keep the server's spoken-sentence language in step with the chosen voice language
    if (["en", "hi", "es"].includes(code) && !$("askForm").hidden) { try { await mcp.callTool("remember_preference", { kind: "language", value: code }); } catch { /* not linked yet */ } }
  });
  const setReplies = (on) => { voiceReplies = on; store("hearth.voiceReplies", on ? "1" : "0"); $("speaker").setAttribute("aria-pressed", String(on)); if (!on) stopSpeaking(); };
  setReplies(voiceReplies);
  $("speaker").addEventListener("click", () => setReplies(!voiceReplies));
  if (voice.supported) {
    $("mic").hidden = false;
    $("hands").hidden = false;
    $("mic").addEventListener("click", () => { if (voice.active) { voice.stop(); stopSpeaking(); return; } setReplies(true); chime(); voice.start(); });
    $("hands").addEventListener("click", () => { if (voice.hands) { voice.setHands(false); } else { setReplies(true); chime(); voice.setHands(true); } $("hands").setAttribute("aria-pressed", String(voice.hands)); });
  } else $("voiceNote").textContent = "This browser can speak replies, but cannot listen. Use Chrome for voice input.";
}
setupVoiceControls();

// End the alert stream when the page goes away instead of letting it retry against a dead tab.
addEventListener("pagehide", () => mcp.stop());

boot();

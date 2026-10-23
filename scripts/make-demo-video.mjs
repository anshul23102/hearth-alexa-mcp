// Records the demo video: drives the real simulator in headless Chrome (screencast over the DevTools protocol), narrates the
// scenes in docs/DEMO-SCRIPT.md with macOS `say`, voices Alexa's actual replies in a second voice, and mixes it all with ffmpeg.
// Needs Google Chrome, ffmpeg, and a Hearth server on HEARTH_URL (default http://localhost:3939) to show the live Claude brain.
// A second throwaway server (offline brain, operator token) is started for the push-alert scene.
//   npm run demo:video      ->  docs/demo/hearth-demo.mp4
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const A = process.env.HEARTH_URL ?? "http://localhost:3939"; // shows the Claude brain when started with Bedrock credentials
const PORT_B = 3956, DEBUG = 9334, TOKEN = randomBytes(18).toString("hex");
const B = `http://localhost:${PORT_B}`;
const RATE = process.env.RATE ?? "180"; // words per minute for the macOS fallback voices
const TTS_DIR = process.env.HEARTH_TTS_DIR, TTS_PORT = 8767, TTS = `http://127.0.0.1:${TTS_PORT}`;
let ttsUp = false;
const W = 1440, H = 900;
const tmp = mkdtempSync(join(tmpdir(), "hearth-demo-"));
mkdirSync(join(tmp, "frames")); mkdirSync(join(tmp, "audio"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const run = (cmd, args, opts) => { const c = spawn(cmd, args, { stdio: "ignore", ...opts }); children.push(c); return c; };
const cleanup = () => children.forEach((c) => c.kill());
process.on("exit", cleanup);
async function until(fn, what, ms = 25000) {
  const t0 = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(120); }
}

// ---- servers and browser -------------------------------------------------------------------------------------------
const status = await (await fetch(`${A}/api/agent/status`)).json().catch(() => ({}));
console.log(`main server ${A}: brain = ${status.mode ?? "unreachable"}`);
if (!status.mode) throw new Error(`no Hearth server at ${A}; start it with npm start`);

const live = join(ROOT, "data/hearth.db");
let useLive = false;
if (existsSync(live)) { const src = new DatabaseSync(live, { readOnly: true }); try { if (src.prepare("SELECT count(*) n FROM recalls").get().n > 1000) { src.exec(`VACUUM INTO '${join(tmp, "b.db")}'`); useLive = true; } } finally { src.close(); } }
run(process.execPath, ["--import", "tsx", "src/http.ts"], { cwd: ROOT, env: { ...process.env, AWS_BEARER_TOKEN_BEDROCK: "", PORT: String(PORT_B), HEARTH_DB: join(tmp, "b.db"), HEARTH_AGENT: "local", HEARTH_RECALLS_SYNC: "off", HEARTH_TTS: "off", HEARTH_ADMIN_TOKEN: TOKEN, ...(useLive ? {} : { HEARTH_RECALLS_OFFLINE: "1" }) } });
await until(async () => (await (await fetch(`${B}/readyz`)).json()).ready, "the second server");
run(CHROME, ["--headless=new", `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${join(tmp, "profile")}`, "--no-first-run", "--hide-scrollbars", `--window-size=${W},${H}`, "about:blank"]);
const target = await until(async () => (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find((t) => t.type === "page"), "Chrome");

// ---- a minimal DevTools client -------------------------------------------------------------------------------------
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let id = 0; const pending = new Map(); const cards = []; let frameHandler = () => {};
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.bad(new Error(m.error.message)) : p.ok(m.result); }
  else if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "iframe") cards.push(m.params.sessionId);
  else if (m.method === "Page.screencastFrame") { send("Page.screencastFrameAck", { sessionId: m.params.sessionId }).catch(() => {}); frameHandler(m.params.data); }
};
const send = (method, params = {}, sessionId) => new Promise((ok, bad) => { const i = ++id; pending.set(i, { ok, bad }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const evaluate = async (expression, sessionId) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluation failed");
  return r.result.value;
};
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.confirm = () => true;
addEventListener("DOMContentLoaded", () => {
  if (top !== window) return; // not inside the receipt card
  const css = document.createElement("style");
  css.textContent = "#dcur{position:fixed;z-index:99999;width:26px;height:26px;margin:-4px 0 0 -4px;border-radius:50%;background:#ff5a4388;border:3px solid #fff;pointer-events:none;left:60%;top:70%;transition:left .65s cubic-bezier(.3,.7,.2,1),top .65s cubic-bezier(.3,.7,.2,1),transform .12s}#dcur.dn{transform:scale(.6)}#dcap{position:fixed;z-index:99998;left:0;right:0;bottom:46px;padding:12px 24px;background:#070f5cee;color:#fff;font:600 17px/1.3 ui-monospace,Menlo,monospace;text-align:center;opacity:0;transition:opacity .3s}#dcap.on{opacity:1}";
  document.head.append(css);
  const c = document.createElement("div"); c.id = "dcur"; document.body.append(c);
  const p = document.createElement("div"); p.id = "dcap"; document.body.append(p);
});` });

// ---- timeline: frames, narration, replies --------------------------------------------------------------------------
const frames = []; const audio = []; let t0 = 0, nAudio = 0, audioEnd = 0, recording = false, flagged = [];
const now = () => Date.now() - t0;
const mark = (name) => console.log(`${(now() / 1000).toFixed(1).padStart(6)} s  ${name}`);
frameHandler = (b64) => { if (!recording) return; const name = `f${String(frames.length).padStart(6, "0")}.jpg`; writeFileSync(join(tmp, "frames", name), Buffer.from(b64, "base64")); frames.push({ name, t: now() }); };
// Voices: natural neural voices from a local Kokoro server when HEARTH_TTS_DIR is set (see scripts/tts-server.py), otherwise macOS `say`.
const NARR = { say: "Samantha", kokoro: "am_michael", speed: 1.05, lang: "en-us" };
const ALEX = { say: "Flo (English (US))", kokoro: "af_heart", speed: 1.0, lang: "en-us" };
const ALEX_ES = { say: "Flo (Spanish (Mexico))", kokoro: "ef_dora", speed: 1.0, lang: "es" };
const cache = new Map(); // "voice|text" -> { file, dur }
const probe = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
async function render(text, v) {
  const key = `${v.kokoro}|${text}`;
  if (cache.has(key)) return cache.get(key);
  let file;
  if (ttsUp) {
    file = join(tmp, "audio", `a${nAudio++}.wav`);
    const r = await fetch(TTS, { method: "POST", body: JSON.stringify({ text, voice: v.kokoro, speed: v.speed, lang: v.lang }) });
    if (!r.ok) throw new Error(`speech synthesis failed for: ${text.slice(0, 40)}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  } else {
    file = join(tmp, "audio", `a${nAudio++}.aiff`);
    execFileSync("say", ["-v", v.say, "-r", RATE, "-o", file, text]);
  }
  const clip = { file, dur: probe(file) }; cache.set(key, clip); return clip;
}
function schedule(clip) { // clips never overlap: each starts when the previous one has finished
  const at = Math.max(now(), audioEnd);
  audioEnd = at + clip.dur * 1000 + 250;
  audio.push({ file: clip.file, at, dur: clip.dur });
  return sleep(audioEnd - now());
}
const voice = (text, v) => { const hit = cache.get(`${v.kokoro}|${text}`); return hit ? schedule(hit) : render(text, v).then(schedule); }; // narration is pre-rendered, so it starts the instant it is called
const narrate = (text) => voice(text, NARR);
const brief = (t) => { const parts = t.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+/g) ?? [t]; let out = ""; for (const x of parts) { if (out && (out + x).length > 130) break; out += x; } return out.trim() || t.slice(0, 130); };
const alexa = async () => { const text = await evaluate(`document.getElementById("say").innerText`); await voice(brief(text), /[¿¡áéíóúñ]|\b(tienes|hay|los|las)\b/i.test(text) ? ALEX_ES : ALEX); return text; };

// ---- natural voices (optional) ------------------------------------------------------------------------------------
if (TTS_DIR) {
  ttsUp = await fetch(TTS).then((r) => r.ok, () => false);
  if (!ttsUp) {
    run(join(TTS_DIR, "venv/bin/python"), [join(ROOT, "scripts/tts-server.py"), "--model", join(TTS_DIR, "kokoro-v1.0.onnx"), "--voices", join(TTS_DIR, "voices-v1.0.bin"), "--port", String(TTS_PORT)], { cwd: TTS_DIR });
    ttsUp = await until(() => fetch(TTS).then((r) => r.ok, () => false), "the speech server", 90000);
  }
  // render every narration line before recording, so none of them starts late
  const lines = [...readFileSync(import.meta.filename, "utf8").matchAll(/narrate\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => JSON.parse(`"${m[1]}"`));
  for (const line of lines) await render(line, NARR);
  console.log(`speech: Kokoro neural voices (${lines.length} narration lines rendered)`);
} else console.log("speech: macOS voices (set HEARTH_TTS_DIR for natural neural voices)");

// ---- scene helpers -------------------------------------------------------------------------------------------------
const $ = (id) => `document.getElementById(${JSON.stringify(id)})`;
const caption = (text) => evaluate(`(() => { const p = document.getElementById("dcap"); if (!p) return; if (${JSON.stringify(text)}) { p.textContent = ${JSON.stringify(text)}; p.classList.add("on"); } else p.classList.remove("on"); })()`);
const goTo = async (url) => { await send("Page.navigate", { url }); await sleep(900); await until(() => evaluate(`document.readyState === "complete" && !!document.getElementById("dcur")`), "the page"); };
async function moveTo(x, y) { await evaluate(`(() => { const c = document.getElementById("dcur"); c.style.left = ${x} + "px"; c.style.top = ${y} + "px"; })()`); await sleep(600); }
async function press() { await evaluate(`document.getElementById("dcur").classList.add("dn")`); await sleep(160); await evaluate(`document.getElementById("dcur").classList.remove("dn")`); }
async function clickEl(selector) { // moves the visible pointer to a real element on the page, then clicks it
  const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
  await moveTo(...r); await press(); await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function clickCard(selector) { // the receipt card is a sandboxed iframe in its own session
  const session = cards.at(-1); if (!session) throw new Error("no card on screen");
  const inner = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`, session);
  const frame = await evaluate(`(() => { const f = [...document.querySelectorAll("iframe")].at(-1).getBoundingClientRect(); return [f.x, f.y]; })()`);
  await moveTo(frame[0] + inner[0], frame[1] + inner[1]); await press();
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`, session);
}
const idle = () => evaluate(`${$("lightbar")}.dataset.state === "idle" && ${$("say")}.innerText.length > 0`);
async function ask(text) { // types the question, sends it, resolves when the answer is on screen
  const before = await evaluate(`${$("say")}.innerText`);
  const box = await evaluate(`(() => { const b = ${$("ask")}.getBoundingClientRect(); return [b.x + 120, b.y + b.height / 2]; })()`);
  await moveTo(...box);
  for (let i = 1; i <= text.length; i++) { await evaluate(`${$("ask")}.value = ${JSON.stringify(text.slice(0, i))}`); await sleep(26); }
  await sleep(350);
  await evaluate(`${$("askForm")}.requestSubmit()`);
  await sleep(500);
  await until(async () => (await idle()) && (await evaluate(`${$("say")}.innerText`)) !== before, `an answer to "${text}"`, 60000);
  if (/unavailable right now/.test(await evaluate(`${$("status")}.innerText`))) flagged.push(text);
  await sleep(700);
}
const linkAndAllow = async () => {
  await clickEl("#linkBtn");
  await until(() => evaluate(`!!document.querySelector("form button")`), "the consent page");
  await sleep(2400); // the consent page ignores instant clicks (clickjacking guard)
  await clickEl("form button");
  await until(() => evaluate(`!!document.getElementById("loadBtn") && !document.getElementById("loadStep").hidden`), "the load step");
};
const load = async (file) => { await evaluate(`${$("sampleSel")}.value = ${JSON.stringify(file)}`); await sleep(600); await clickEl("#loadBtn"); await sleep(800); await until(idle, "the import answer", 30000); };

// ---- before the camera rolls: link the second server and give it the household that owns the recalled pressure cooker ----
await goTo(B); await linkAndAllow(); await load("sample-orders.csv");

// ---- recording -----------------------------------------------------------------------------------------------------
await goTo(A);
await send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
t0 = Date.now(); recording = true;
await sleep(500);

mark("1. the problem, and what Hearth");
await caption("Hearth: recall alerts and safe reordering for Alexa+");
await narrate("Recalls are published, but owners are rarely reached. And an assistant that can spend your money has no safety standard. Hearth is an Alexa Plus add-on that fixes both.");
await caption("");

mark("2. real account linking and the");
await caption("Real OAuth 2.1 + PKCE account linking, then MCP 2025-11-25 over Streamable HTTP");
const n1 = narrate("A real O Auth account link with P K C E, then M C P over streamable H T T P. Every message is visible here.");
await linkAndAllow(); await sleep(600); await clickEl("#wireToggle"); await n1; await clickEl("#wireToggle"); await caption("");

mark("3. a messy household export");
await caption("A deliberately messy export: mixed dates, duplicates, cancellations, retitled listings");
const n3 = narrate("A household with a baby, loaded from a messy order export. Hearth cleans it and says what it did.");
await load("sample-family.csv"); await sleep(900); await n3; await caption("");

mark("4. forecast");
await caption("Forecast: a likely window and a confidence, never a fake-precise date");
const n4 = narrate("Now I just ask. Hearth learned this household's pace from its purchases, so every item gets a likely window, never a fake precise date.");
await ask("What are we running low on?"); await n4; await alexa(); await sleep(600); await caption("");

mark("5. recalls");
await caption("Matched on brand, product type and model number against real CPSC and Health Canada notices");
const n5 = narrate("It checks everything the household owns against real recall notices from the U S and Canada, by brand, product type and model number, and shows its evidence.");
await ask("Any recalls on what we own?"); await n5; await alexa(); await sleep(1200); await caption("");

mark("6. not a store");
await caption("Hearth is not a store: it restocks only what a household already buys");
const n6 = narrate("Hearth is not a store. It only restocks what a household already buys.");
await ask("Order me ten laptops"); await n6; await alexa(); await sleep(400); await caption("");

mark("7. safe reordering");
await caption("Plan first. Nothing is bought until you say yes.");
const n7 = narrate("When it restocks, it plans first, within a budget. Nothing is bought until I confirm.");
await ask("Plan a restock under sixty dollars"); await n7; await sleep(1200);
const n8 = narrate("Confirm calls back over M C P. Orders are idempotent, capped by limits the model cannot change, and audited.");
await clickCard("#place"); await sleep(1800); await n8;
const n9 = narrate("And there is a ten minute undo.");
await clickCard("#undo"); await n9; await caption("");

mark("8. the push");
await goTo(B); await sleep(1800);
await caption("Operator command: npm run demo:recall -- Foodi   (replays a real CPSC notice as if just published)");
const n10 = narrate("Now the part that matters. A recall is published. Hearth finds every owner and pushes it to their open Alexa Plus session over an M C P subscription.");
await sleep(4200);
const res = await (await fetch(`${B}/api/admin/recalls/replay`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ source: "cpsc", titleContains: "Foodi" }) })).json();
if (!res.notifiedSessions) throw new Error(`the recall was not pushed: ${JSON.stringify(res)}`);
await until(() => evaluate(`!document.getElementById("alertbar").hidden`), "the pushed alert", 15000);
await n10; await alexa(); await sleep(1500); await caption("");

mark("9. the real world: another coun");
await goTo(A); await sleep(1200);
await caption("Day-first dates, rupees, and replies in Spanish and Hindi; or import your own export");
const n11 = narrate("It handles other countries too: rupees, day first dates. Or load your own export.");
await load("sample-india.csv"); await sleep(700); await n11;
const chip = await evaluate(`[...document.querySelectorAll("#chips button")].findIndex((b) => /Spanish/i.test(b.textContent))`);
if (chip >= 0) {
  const n12 = narrate("And it speaks Spanish, Hindi and English.");
  await clickEl(`#chips button:nth-child(${chip + 1})`); await sleep(1500); await until(idle, "the Spanish reply", 30000); await alexa(); await n12;
}
await caption("");

mark("10. evidence and close");
const slide = (file, bg) => { const page = join(tmp, `${file}.html`); writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:${bg}}img{width:100vw;height:100vh;object-fit:contain}</style><img src="${pathToFileURL(join(ROOT, "docs/gallery", file + ".png")).href}">`); return pathToFileURL(page).href; };
await send("Page.navigate", { url: slide("5-measured", "#2236d9") }); await sleep(900);
await narrate("Measured, not claimed. Eighty five percent of known recalls surfaced, zero false alerts on unrelated products, one hundred thirty four tests, nineteen security findings fixed.");
await send("Page.navigate", { url: slide("thumbnail", "#2236d9") }); await sleep(900);
await narrate("Hearth. Recall alerts and safe reordering for Alexa Plus. Open source, M I T.");
await sleep(600);
recording = false;
await send("Page.stopScreencast");

// ---- clean up the household this run created on the main server ---------------------------------------------------
await goTo(A); await sleep(1200);
if (await evaluate(`!!document.getElementById("forget") && !document.getElementById("forget").hidden`)) { await evaluate(`document.getElementById("forget").click()`); await sleep(2500); }

// ---- assemble ------------------------------------------------------------------------------------------------------
// Waiting for the model is real time but dead air on video: any stretch with no speech longer than MIN_GAP is cut down to KEEP.
const KEEP = 1000, MIN_GAP = 2200;
const cuts = []; let spoken = 0;
for (const a of [...audio].sort((x, y) => x.at - y.at)) {
  if (spoken > 0 && a.at - spoken > MIN_GAP) cuts.push({ from: spoken + KEEP, to: a.at });
  spoken = Math.max(spoken, a.at + a.dur * 1000 + 250);
}
const remap = (t) => cuts.reduce((m, c) => m - (t >= c.to ? c.to - c.from : t > c.from ? t - c.from : 0), t);
const kept = frames.filter((f, i) => !cuts.some((c) => f.t > c.from && f.t < c.to && frames[i + 1] && frames[i + 1].t < c.to)); // inside a cut, keep only the frame that is current when it ends
const total = remap(frames.at(-1).t) + 800;
const list = kept.map((f, i) => `file '${join(tmp, "frames", f.name)}'\nduration ${Math.max(0.001, ((kept[i + 1] ? remap(kept[i + 1].t) : total) - remap(f.t)) / 1000).toFixed(3)}`).join("\n") + `\nfile '${join(tmp, "frames", kept.at(-1).name)}'\n`;
writeFileSync(join(tmp, "frames.txt"), list);
console.log(`cut ${((frames.at(-1).t - remap(frames.at(-1).t)) / 1000).toFixed(1)} s of waiting from ${cuts.length} silent stretches`);
const out = join(ROOT, "docs/demo"); mkdirSync(out, { recursive: true });
const inputs = audio.flatMap((a) => ["-i", a.file]);
const delays = audio.map((a, i) => `[${i + 1}:a]aresample=44100,adelay=${Math.round(remap(a.at))}|${Math.round(remap(a.at))}[a${i}]`).join(";");
const mix = `${delays};${audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${audio.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(tmp, "frames.txt"), ...inputs, "-filter_complex", mix, "-map", "0:v", "-map", "[aout]",
  "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-t", (total / 1000).toFixed(2), "-movflags", "+faststart", join(out, "hearth-demo.mp4")]);
const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(out, "hearth-demo.mp4")]).toString());
console.log(`wrote docs/demo/hearth-demo.mp4  (${seconds.toFixed(1)} s)`);
if (flagged.length) console.log(`NOTE: the model was unavailable for: ${flagged.join(" | ")}; answered by the offline router. Record again.`);
if (seconds > 180) console.log("WARNING: longer than the 3:00 limit; shorten the narration.");
cleanup();
process.exit(0);

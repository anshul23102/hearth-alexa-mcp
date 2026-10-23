// Regenerates the gallery images in docs/gallery from the running app: starts a throwaway server on an offline recall snapshot,
// drives the real simulator in headless Chrome over the DevTools protocol (link, load, ask, place order, push a recall), and
// frames each screenshot on a 3:2 canvas with a caption. Needs Google Chrome; run `npm run gallery`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 3955, DEBUG = 9333, TOKEN = randomBytes(18).toString("hex"); // a fresh operator token for this throwaway server
const BASE = `http://localhost:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "hearth-gallery-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const run = (cmd, args, opts) => { const c = spawn(cmd, args, { stdio: "ignore", ...opts }); children.push(c); return c; };
const cleanup = () => children.forEach((c) => c.kill());
process.on("exit", cleanup);

async function until(fn, what, ms = 20000) {
  const t0 = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(150); }
}

// Use the real recall index if this machine has synced one (about 10,000 notices); otherwise the small bundled snapshot.
const live = join(ROOT, "data/hearth.db");
const useLive = existsSync(live) && (() => { const src = new DatabaseSync(live, { readOnly: true }); try { return src.prepare("SELECT count(*) n FROM recalls").get().n > 1000 && (src.exec(`VACUUM INTO '${join(tmp, "g.db")}'`), true); } finally { src.close(); } })();
console.log(useLive ? "using the synced recall index" : "using the bundled recall snapshot");

// ---- server and browser --------------------------------------------------------------------------------------------
run(process.execPath, ["--import", "tsx", "src/http.ts"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HEARTH_DB: join(tmp, "g.db"), HEARTH_AGENT: "local", HEARTH_RECALLS_SYNC: "off", ...(useLive ? {} : { HEARTH_RECALLS_OFFLINE: "1" }), HEARTH_ADMIN_TOKEN: TOKEN } });
await until(async () => (await (await fetch(`${BASE}/readyz`)).json()).ready, "the server");
run(CHROME, ["--headless=new", `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${join(tmp, "profile")}`, "--no-first-run", "--hide-scrollbars", "about:blank"]);
const target = await until(async () => (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find((t) => t.type === "page"), "Chrome");

// ---- a minimal DevTools client -------------------------------------------------------------------------------------
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let id = 0; const pending = new Map(); const contexts = [];
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id && pending.has(m.id)) { const { ok, bad } = pending.get(m.id); pending.delete(m.id); m.error ? bad(new Error(m.error.message)) : ok(m.result); }
  else if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "iframe") frames.push(m.params.sessionId);
  else if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
  else if (m.method === "Runtime.executionContextsCleared") contexts.length = 0;
};
const send = (method, params = {}, sessionId) => new Promise((ok, bad) => { const i = ++id; pending.set(i, { ok, bad }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const frames = []; // sessions attached to child frames (the sandboxed receipt card is one)
const evaluate = async (expression, contextId) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluation failed");
  return r.result.value;
};
const view = (width, height, scale) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
const shoot = async (file) => writeFileSync(file, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
await send("Page.enable"); await send("Runtime.enable");
await view(1452, 800, 2);

// ---- drive the real app --------------------------------------------------------------------------------------------
process.on("uncaughtException", async (e) => { // say where the page was, so a changed UI is easy to diagnose
  console.error(e.message, "\nat", await evaluate("location.href").catch(() => "?"), "\n", (await evaluate("document.body.innerText.slice(0, 300)").catch(() => "")));
  process.exit(1);
});
await send("Page.navigate", { url: BASE });
await until(() => evaluate(`!!document.getElementById("linkBtn") && !document.getElementById("linkStep").hidden`), "the link button");
await evaluate(`document.getElementById("linkBtn").click()`);
await until(() => evaluate(`!!document.querySelector("form button")`), "the consent page");
await sleep(1500); // the consent page ignores instant clicks (clickjacking guard)
await evaluate(`document.querySelector("form button").click()`);
await until(() => evaluate(`!!document.getElementById("loadBtn") && !document.getElementById("loadStep").hidden`), "the load button");
await evaluate(`document.getElementById("loadBtn").click()`);
await until(() => evaluate(`!document.getElementById("askForm").hidden`), "the ask box");

const settled = () => evaluate(`document.getElementById("lightbar").dataset.state === "idle" && document.getElementById("say").innerText.length > 0`);
async function ask(text) {
  await until(settled, "Hearth to be idle");
  await evaluate(`document.getElementById("ask").value = ${JSON.stringify(text)}; document.getElementById("askForm").requestSubmit()`);
  await sleep(400);
  await until(settled, `an answer to "${text}"`);
  await sleep(3500); // the receipt prints line by line
}
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
const inCard = async (js) => { // the receipt card is a sandboxed iframe in its own session
  const session = frames.at(-1);
  if (!session) throw new Error("no card is on screen");
  const r = await send("Runtime.evaluate", { expression: js, returnByValue: true }, session);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "card script failed");
  return r.result.value;
};

const shots = {};
await ask("What are we running low on?");           shots["1-runway"] = join(tmp, "1.png"); await shoot(shots["1-runway"]);
await ask("Any recalls on what we own?");           shots["2-recall-match"] = join(tmp, "2.png"); await shoot(shots["2-recall-match"]);
await ask("Plan a restock under $60");
await sleep(1500); // the approval code arrives from the card-only tool
shots["6-approval-code"] = join(tmp, "6.png"); await shoot(shots["6-approval-code"]);
await inCard(`document.getElementById("place").click()`); await sleep(3500);
shots["4-order-receipt"] = join(tmp, "4.png"); await shoot(shots["4-order-receipt"]);
await until(settled, "Hearth to be idle");
const replay = await (await fetch(`${BASE}/api/admin/recalls/replay`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ source: "cpsc", titleContains: "Foodi" }) })).json();
if (!replay.notifiedSessions) throw new Error(`the recall was not pushed: ${JSON.stringify(replay)}`);
await until(() => evaluate(`!document.getElementById("alertbar").hidden`), "the pushed alert banner");
await sleep(4000);
shots["3-recall-alert-push"] = join(tmp, "3.png"); await shoot(shots["3-recall-alert-push"]);

// ---- frame each shot on a 3:2 canvas -------------------------------------------------------------------------------
const captions = {
  "1-runway": "When does each item run out? A likely window and a confidence, never a fake-precise date.",
  "2-recall-match": "Recall matching on brand, product type and model number across real U.S. and Canada notices.",
  "3-recall-alert-push": "A recall is published: its owners are found and the open Alexa+ session is pushed to over MCP.",
  "6-approval-code": "Only the card shows the approval code, so a prompt-injected model cannot place an order.",
  "4-order-receipt": "Nothing is bought until you say yes: idempotent order, 10-minute undo, tamper-evident audit log.",
};
const fonts = pathToFileURL(join(ROOT, "web/fonts")).href;
await view(1452, 968, 1);
for (const [name, file] of Object.entries(shots)) {
  const page = join(tmp, `${name}.html`);
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:B;src:url(${fonts}/bricolage-700.woff2);font-weight:700}
@font-face{font-family:M;src:url(${fonts}/martian-400.woff2)}
html,body{margin:0;width:1452px;height:968px;background:#2236d9;color:#f3f6f8;overflow:hidden}
h1{margin:0;position:absolute;left:47px;top:34px;width:1360px;font:700 29px/1.25 B,system-ui,sans-serif}
img{position:absolute;left:0;top:112px;width:1452px;height:800px}
p{margin:0;position:absolute;left:47px;top:924px;font:400 14px M,monospace;color:#c9d3ff;white-space:nowrap}
</style><h1>${captions[name]}</h1><img src="${pathToFileURL(file).href}"><p>HEARTH · recall alerts and safe reordering for Alexa+ &nbsp;·&nbsp; real app screenshot, synthetic order data</p>`);
  await send("Page.navigate", { url: pathToFileURL(page).href });
  await until(() => evaluate(`document.fonts.ready.then(() => document.images[0].complete)`), "the framed page");
  await sleep(300);
  await shoot(join(ROOT, "docs/gallery", `${name}.png`));
  console.log("wrote", `docs/gallery/${name}.png`);
}
// The measured-numbers slide: figures come from docs/SCALE.md and `npm run eval`; the counts are read from the repo.
const tests = Number(/^npm test +# (\d+) tests:/m.exec(readFileSync(join(ROOT, "README.md"), "utf8"))?.[1]);
const findings = (readFileSync(join(ROOT, "SECURITY.md"), "utf8").match(/^\| F\d+ \|/gm) ?? []).length;
const stat = (big, red, title, note) => `<div class="c"><b class="${red ? "r" : ""}">${big}</b><h2>${title}</h2><small>${note}</small></div>`;
const measured = join(tmp, "measured.html");
writeFileSync(measured, `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:B;src:url(${fonts}/bricolage-700.woff2);font-weight:700}
@font-face{font-family:M;src:url(${fonts}/martian-400.woff2)}
html,body{margin:0;width:1452px;height:968px;background:#2236d9;color:#f3f6f8;overflow:hidden}
h1{margin:0;position:absolute;left:84px;top:52px;font:700 64px/1.1 B,system-ui,sans-serif}
.sub{position:absolute;left:86px;top:128px;font:400 17px M,monospace;color:#c9d3ff}
.g{position:absolute;left:84px;top:200px;width:1285px;display:grid;grid-template-columns:1fr 1fr;gap:23px}
.c{background:#f3f6f8;color:#0c1230;height:291px;box-sizing:border-box;padding:30px 34px}
.c b{display:block;font:700 112px/1 B,system-ui,sans-serif;letter-spacing:-2px}.c b.r{color:#cc2512}
.c h2{margin:26px 0 10px;font:700 31px/1.1 B,system-ui,sans-serif}.c small{font:400 13px M,monospace;color:#4a5170}
.f{position:absolute;left:84px;top:910px;font:400 13px M,monospace;color:#c9d3ff}
</style><h1>Measured, not claimed</h1><div class="sub">Reproducible from the repo: npm run bench, npm run eval, npm test.</div><div class="g">
${stat("85.4%", false, "of known recalls surfaced", "1,670 cases from real CPSC notices (upper bound)")}
${stat("0%", true, "false alerts on an unrelated product", "same brand, 1,670 cases; 2.1% false 'likely' on wrong model")}
${stat("13–15 s", false, "676,000 orders, 5,000 households", "12.7 to 15.4 s over three runs; per-household queries &lt; 1 ms")}
${stat("37 ms", false, "one new recall to 1,250 owners", "brand index + same scorer; push to open sessions only")}
</div><div class="f">Also: ${tests} automated tests, 500k-row upload in about 13 s with p99 13 ms for other users, hash-chained audit log, ${findings} security findings fixed.</div>`);
await send("Page.navigate", { url: pathToFileURL(measured).href });
await until(() => evaluate("document.fonts.ready.then(() => true)"), "the measured slide");
await sleep(300);
await shoot(join(ROOT, "docs/gallery/5-measured.png"));
console.log("wrote docs/gallery/5-measured.png");
copyFileSync(join(ROOT, "docs/gallery/3-recall-alert-push.png"), join(ROOT, "docs/gallery/thumbnail.png"));
console.log("wrote docs/gallery/thumbnail.png");
cleanup();
process.exit(0);

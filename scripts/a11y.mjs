// Accessibility audit: runs axe-core (WCAG 2.1 A and AA plus best practices) against the real simulator in headless Chrome, on every
// screen a person meets: unlinked, linked, each result card (inside its sandboxed iframe), and both drawers.  `npm run a11y`
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 3964, DEBUG = 9342, TOKEN = randomBytes(18).toString("hex"); // a fresh operator token for this throwaway server
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


await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1452, height: 1400, deviceScaleFactor: 1, mobile: false });
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
process.on("uncaughtException", (e) => { console.error(e.message); process.exit(2); });
const AXE = readFileSync(join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");
const OPTS = JSON.stringify({ runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } });
const RUN = `axe.run(document, ${OPTS}).then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ") + " | " + (n.failureSummary || "").replace(/\\s+/g, " ").slice(0, 160)) })))`;
const findings = [];
async function audit(label, attempt = 0) {
  try {
    await evaluate(AXE);
    const main = await evaluate(RUN);
    let card = null;
    const session = frames.at(-1);
    if (session) {
      await send("Runtime.evaluate", { expression: AXE }, session);
      const r = await send("Runtime.evaluate", { expression: RUN, awaitPromise: true, returnByValue: true }, session);
      card = r.result.value ?? [];
    }
    for (const v of main) findings.push({ screen: label, where: "page", ...v });
    for (const v of card ?? []) findings.push({ screen: label, where: "card", ...v });
    console.log(`${label.padEnd(24)} page: ${String(main.length).padStart(2)} issue(s)   card: ${card ? String(card.length).padStart(2) + " issue(s)" : "n/a"}`);
  } catch (e) { // the page may still be navigating (the link and consent steps redirect); look again
    if (attempt > 4) throw e;
    await sleep(900);
    return audit(label, attempt + 1);
  }
}
const settled = () => evaluate(`document.getElementById("lightbar").dataset.state === "idle" && document.getElementById("say").innerText.length > 0`);
async function ask(text) {
  await until(settled, "Hearth to be idle");
  await evaluate(`document.getElementById("ask").value = ${JSON.stringify(text)}; document.getElementById("askForm").requestSubmit()`);
  await sleep(400); await until(settled, `an answer to "${text}"`); await sleep(2500);
}
const inCard = async (js) => { const s = frames.at(-1); if (!s) throw new Error("no card"); const r = await send("Runtime.evaluate", { expression: js, returnByValue: true }, s); return r.result.value; };

await send("Page.navigate", { url: BASE });
await until(() => evaluate(`!!document.getElementById("linkBtn") && !document.getElementById("linkStep").hidden`), "the link screen");
await audit("unlinked");
await evaluate(`document.getElementById("linkBtn").click()`).catch(() => {}); // navigates away mid-call
await until(() => evaluate(`!!document.querySelector("form button")`), "the consent page");
await audit("consent page");
await sleep(2400); await evaluate(`document.querySelector("form button").click()`).catch(() => {});
await until(() => evaluate(`!!document.getElementById("loadBtn") && !document.getElementById("loadStep").hidden`), "the load step");
await audit("load step");
await evaluate(`document.getElementById("loadBtn").click()`);
await until(() => evaluate(`!document.getElementById("askForm").hidden`), "the ask box");
await until(settled, "the import answer");
await audit("linked");
await ask("What are we running low on?");   await audit("runway card");
await ask("Any recalls on what we own?");   await audit("recall card");
await ask("Plan a restock under $60");      await audit("plan card");
await inCard(`document.getElementById("place").click()`); await sleep(2500);
await audit("receipt card");
await evaluate(`document.getElementById("wireToggle").click()`); await sleep(600); await audit("wire drawer");
await evaluate(`document.getElementById("ledgerToggle").click()`); await sleep(1200); await audit("safety ledger drawer");

const byRule = new Map();
for (const f of findings) { const k = `${f.id} (${f.impact})`; byRule.set(k, [...(byRule.get(k) ?? []), f]); }
console.log(`\n${findings.length} issue(s) across ${byRule.size} rule(s)`);
for (const [rule, list] of byRule) {
  console.log(`\n${rule}: ${list[0].help}`);
  for (const f of list.slice(0, 4)) console.log(`  [${f.screen}/${f.where}] ${f.nodes[0] ?? ""}`);
}
cleanup();
process.exit(findings.some((f) => f.impact === "serious" || f.impact === "critical") ? 1 : 0);

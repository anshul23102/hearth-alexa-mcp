import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

// The MCP App view is a single HTML file with an inline script; a typo there fails silently in the
// iframe, so compile it in CI and check the host protocol hooks are present.
const html = readFileSync(new URL("../src/view.html", import.meta.url), "utf8");
const script = html.match(/<script\b[^>]*>([\s\S]*)<\/script\s*>/i)![1];

test("view script compiles", () => {
  assert.doesNotThrow(() => new Script(script, { filename: "view.html" }));
});

test("view implements the MCP Apps handshake and every result view", () => {
  for (const s of ["ui/initialize", "ui/notifications/initialized", "ui/notifications/tool-result", "ui/notifications/size-changed", "ui/open-link", "tools/call"]) assert.ok(script.includes(s), s);
  for (const v of ["runway", "recalls", "proposal", "receipt", "undo", "log"]) assert.match(script, new RegExp(`\\b${v}\\b`));
});

test("pushed alerts get their own subtitle instead of a recall-notice count they were never given", () => {
  assert.match(script, /sc\.fromAlerts \? "Found the moment the notice was published/);
  assert.match(script, /sc\.fromAlerts \? "New recall alert"/);
});

test("documentation states the real number of automated tests", async () => {
  const { readdirSync } = await import("node:fs");
  const n = readdirSync(new URL("../test/", import.meta.url)).filter((f) => f.endsWith(".test.ts"))
    .reduce((sum, f) => sum + (readFileSync(new URL(`../test/${f}`, import.meta.url), "utf8").match(/^test\(/gm)?.length ?? 0), 0);
  for (const [file, needle] of [["README.md", `# ${n} tests:`], ["docs/DEVPOST_STORY.md", `${n} automated tests`], ["docs/DEMO-SCRIPT.md", `ending in ${n} passing`]] as const) {
    assert.ok(readFileSync(new URL(`../${file}`, import.meta.url), "utf8").includes(needle), `${file} should say "${needle}" (the suite has ${n} tests)`);
  }
});

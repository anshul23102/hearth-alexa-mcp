import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

// The MCP App view is a single HTML file with an inline script; a typo there fails silently in the
// iframe, so compile it in CI and check the host protocol hooks are present.
const html = readFileSync(new URL("../src/view.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)![1];

test("view script compiles", () => {
  assert.doesNotThrow(() => new Script(script, { filename: "view.html" }));
});

test("view implements the MCP Apps handshake and every result view", () => {
  for (const s of ["ui/initialize", "ui/notifications/initialized", "ui/notifications/tool-result", "ui/notifications/size-changed", "ui/open-link", "tools/call"]) assert.ok(script.includes(s), s);
  for (const v of ["runway", "recalls", "proposal", "receipt", "undo", "log"]) assert.match(script, new RegExp(`\\b${v}\\b`));
});

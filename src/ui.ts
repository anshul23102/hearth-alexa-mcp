import { readFileSync } from "node:fs";

// MCP Apps view (https://github.com/modelcontextprotocol/ext-apps). One self-contained
// HTML document; the host renders it in a sandboxed iframe and drives it over postMessage.
export const RUNWAY_URI = "ui://hearth/runway";
export const RUNWAY_HTML = readFileSync(new URL("./view.html", import.meta.url), "utf8");

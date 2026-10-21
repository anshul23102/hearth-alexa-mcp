// MCP Apps host: renders a tool's ui:// resource in a sandboxed iframe and speaks the
// View <-> Host JSON-RPC protocol over postMessage (ui/initialize, tool-input, tool-result,
// size-changed, tools/call proxying, open-link).

const OPEN_OK = /^https:\/\/(www\.)?cpsc\.gov\//;

export function mountApp({ html, mcp, toolName, args, result, onToolResult }) {
  const frame = document.createElement("iframe");
  frame.title = "Hearth screen";
  frame.className = "appframe";
  frame.setAttribute("sandbox", "allow-scripts"); // opaque origin: the view cannot touch the host or its token
  frame.srcdoc = `<base href="${location.origin}/">${html}`;
  const reply = (id, result) => frame.contentWindow?.postMessage({ jsonrpc: "2.0", id, result }, "*");
  const fail = (id, message) => frame.contentWindow?.postMessage({ jsonrpc: "2.0", id, error: { code: -32000, message } }, "*");
  const notify = (method, params) => frame.contentWindow?.postMessage({ jsonrpc: "2.0", method, params }, "*");

  const onMessage = async (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    mcp.onWire({ dir: "app", body: m });
    switch (m.method) {
      case "ui/initialize":
        reply(m.id, { protocolVersion: "2026-01-26", hostCapabilities: { openLinks: {}, serverTools: {} }, hostInfo: { name: "hearth-alexa-simulator", version: "0.1.0" }, hostContext: { theme: "light", displayMode: "inline", containerDimensions: { width: frame.clientWidth, maxHeight: 4000 } } });
        break;
      case "ui/notifications/initialized":
        notify("ui/notifications/tool-input", { arguments: args });
        notify("ui/notifications/tool-result", result);
        break;
      case "ui/notifications/size-changed":
        if (m.params?.height) frame.style.height = `${Math.ceil(m.params.height)}px`;
        break;
      case "ui/open-link":
        if (OPEN_OK.test(m.params?.url ?? "")) { window.open(m.params.url, "_blank", "noopener,noreferrer"); reply(m.id, {}); }
        else fail(m.id, "Link not allowed");
        break;
      case "tools/call": {
        const tool = mcp.tools.find((t) => t.name === m.params?.name);
        const vis = tool?._meta?.ui?.visibility ?? ["model", "app"];
        if (!tool || !vis.includes("app")) return fail(m.id, "Tool not available to apps");
        try {
          const r = await mcp.callTool(tool.name, m.params.arguments ?? {});
          reply(m.id, r);
          onToolResult?.(tool.name, m.params.arguments ?? {}, r);
        } catch (err) { fail(m.id, err.message); }
        break;
      }
      default:
        if (m.id !== undefined) fail(m.id, "Unsupported");
    }
  };
  window.addEventListener("message", onMessage);
  frame.dispose = () => window.removeEventListener("message", onMessage);
  return frame;
}

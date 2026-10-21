// Minimal Prometheus-format metrics: counters and gauges, no dependencies, labels kept low-cardinality on purpose.
const counters = new Map<string, number>();
const help = new Map<string, string>();
const gauges = new Map<string, () => number>();
const started = Date.now();

const key = (name: string, labels?: Record<string, string>) =>
  labels && Object.keys(labels).length ? `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, "")}"`).join(",")}}` : name;

export function describe(name: string, text: string) { help.set(name, text); }
export function inc(name: string, labels?: Record<string, string>, by = 1) { const k = key(name, labels); counters.set(k, (counters.get(k) ?? 0) + by); }
export function gauge(name: string, read: () => number) { gauges.set(name, read); }

export function render(): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [k, v] of [...counters].sort()) {
    const name = k.replace(/\{.*$/, "");
    if (!seen.has(name)) { seen.add(name); if (help.has(name)) lines.push(`# HELP ${name} ${help.get(name)}`); lines.push(`# TYPE ${name} counter`); }
    lines.push(`${k} ${v}`);
  }
  for (const [name, read] of gauges) {
    let v = 0; try { v = read(); } catch { /* a failing gauge must not break the scrape */ }
    if (help.has(name)) lines.push(`# HELP ${name} ${help.get(name)}`);
    lines.push(`# TYPE ${name} gauge`, `${name} ${v}`);
  }
  lines.push("# TYPE hearth_uptime_seconds gauge", `hearth_uptime_seconds ${Math.round((Date.now() - started) / 1000)}`);
  return lines.join("\n") + "\n";
}

describe("hearth_http_requests_total", "HTTP requests by route group and status class");
describe("hearth_tool_calls_total", "MCP tool calls by tool and outcome");
describe("hearth_rate_limited_total", "Requests refused by a rate limiter");
describe("hearth_import_rows_total", "Order rows read by imports");
describe("hearth_recall_alerts_total", "Recall alerts created for owners");
describe("hearth_orders_blocked_total", "Orders refused by a spend ceiling");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { confirm, propose, recentAudit, undo, simulatedStore, type StoreAdapter } from "./actions.js";
import { audit } from "./db.js";
import { forecast } from "./forecast.js";
import { ingestOrders } from "./ingest.js";
import { checkRecalls } from "./recalls.js";
import { RUNWAY_HTML, RUNWAY_URI } from "./ui.js";

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const UI_MIME = "text/html;profile=mcp-app";

export interface Deps { db: DatabaseSync; store?: StoreAdapter; now?: () => number }

function getPref(db: DatabaseSync, household: string, key: string): string | null {
  const r = db.prepare("SELECT value FROM prefs WHERE household = ? AND key = ?").get(household, key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function createHearthServer({ db, store = simulatedStore, now = Date.now }: Deps): McpServer {
  const server = new McpServer(
    { name: "hearth", version: "0.1.0", title: "Hearth — your household's memory" },
    {
      instructions:
        "Hearth remembers what the household buys and when it runs out. Call household_runway first to see what is low. " +
        "Never place an order from a guess: call plan_restock, read the plan back to the user, and call confirm_restock only after they say yes. " +
        "Spoken replies should be one or two sentences; details live in structuredContent.",
    },
  );
  const hh = (extra: { authInfo?: { extra?: Record<string, unknown> } }) => String(extra.authInfo?.extra?.household ?? "demo");

  server.registerResource("runway-view", RUNWAY_URI, { title: "Household runway", mimeType: UI_MIME, description: "Card carousel for running-low items, recalls and restock plans." }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: UI_MIME, text: RUNWAY_HTML }],
  }));

  server.registerTool(
    "import_order_history",
    {
      title: "Import order history",
      description:
        "Load a household's past orders from a CSV export (any column order; dates, prices and duplicates are cleaned automatically). " +
        "Safe to call repeatedly: rows already imported are ignored.",
      inputSchema: { csv: z.string().min(20).describe("Full CSV text including the header row") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ csv }, extra) => {
      const report = ingestOrders(db, hh(extra), csv, now());
      const text = `Imported ${report.imported} orders. I ignored ${report.duplicates} duplicates and ${report.skipped.length} cancelled or unreadable rows, and repaired ${report.repaired.length}.`;
      return { content: [{ type: "text", text }], structuredContent: { ...report } };
    },
  );

  server.registerTool(
    "household_runway",
    {
      title: "What's running low",
      description: "Forecast when each regularly bought item will run out, with an honest ± window and confidence.",
      inputSchema: { withinDays: z.number().int().min(1).max(365).default(30).describe("Only highlight items running out within this many days") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: RUNWAY_URI } },
    },
    async ({ withinDays }, extra) => {
      const all = forecast(db, hh(extra), now());
      const due = all.filter((r) => r.daysLeft <= withinDays);
      const phrase = (r: (typeof all)[number]) => r.daysLeft < 0 ? `${r.name} is overdue` : r.daysLeft === 0 ? `${r.name} runs out today` : `${r.name} in ${r.daysLeft} days`;
      const text = all.length === 0
        ? "I don't have enough order history yet. Import your order export and I'll start forecasting."
        : due.length === 0
          ? `Nothing runs out in the next ${withinDays} days. I'm tracking ${all.length} items.`
          : `${due.length} of ${all.length} items run out within ${withinDays} days. Soonest: ${due.slice(0, 3).map(phrase).join(", ")}.`;
      return { content: [{ type: "text", text }], structuredContent: { view: "runway", withinDays, items: all, dueCount: due.length } };
    },
  );

  server.registerTool(
    "check_recalls",
    {
      title: "Check my products for recalls",
      description: "Match durable products the household owns against live U.S. CPSC recall notices. Reports evidence and confidence; never claims a certain match without a model-number hit.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: RUNWAY_URI } },
    },
    async (_a, extra) => {
      const { matches, checked, sources } = await checkRecalls(db, hh(extra), now());
      const likely = matches.filter((m) => m.level === "likely");
      const text = matches.length === 0
        ? `I checked ${checked} products against current CPSC recalls and found no matches.`
        : `${likely.length ? `Heads up: your ${likely[0].owned.name} looks like it is covered by a recall for ${likely[0].recall.hazardShort}. ` : ""}I found ${matches.length} possible recall ${matches.length === 1 ? "match" : "matches"} across ${checked} products.`;
      return { content: [{ type: "text", text }], structuredContent: { view: "recalls", matches, checked, sources } };
    },
  );

  server.registerTool(
    "plan_restock",
    {
      title: "Plan a restock",
      description: "Build a proposed order for items running out soon, within the household budget. Does NOT buy anything; returns a proposal to read back and confirm.",
      inputSchema: {
        withinDays: z.number().int().min(1).max(60).default(14),
        budgetUsd: z.number().positive().max(5000).optional().describe("Override the saved budget for this plan"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: RUNWAY_URI } },
    },
    async ({ withinDays, budgetUsd }, extra) => {
      const h = hh(extra);
      const saved = getPref(db, h, "budget_usd");
      const budget = budgetUsd ?? (saved ? Number(saved) : undefined);
      const skip = new Set((getPref(db, h, "skip_items") ?? "").split("|").filter(Boolean));
      const runway = forecast(db, h, now()).filter((r) => !skip.has(r.productKey));
      const p = propose(db, h, runway, { withinDays, budgetCents: budget ? Math.round(budget * 100) : undefined }, now());
      const text = p.lines.length === 0
        ? "Nothing needs reordering in that window."
        : `Here is a plan: ${p.lines.length} items for ${usd(p.totalCents)}${p.budgetCents ? `, within your ${usd(p.budgetCents)} budget` : ""}. ${p.dropped.length ? `I left out ${p.dropped.length} to stay on budget. ` : ""}Want me to place it?`;
      return { content: [{ type: "text", text }], structuredContent: { view: "proposal", proposal: p } };
    },
  );

  server.registerTool(
    "confirm_restock",
    {
      title: "Place the planned order",
      description:
        "Place a previously planned restock. Only call this after the user has clearly said yes to the specific plan you read back. Safe to retry: the same proposal never orders twice.",
      inputSchema: {
        proposalId: z.string().describe("The id returned by plan_restock"),
        userConfirmed: z.boolean().describe("true only if the user explicitly approved this plan in this conversation"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ proposalId, userConfirmed }, extra) => {
      const h = hh(extra);
      if (!userConfirmed) {
        return { isError: true, content: [{ type: "text", text: "I need an explicit yes before ordering. Read the plan back and ask." }] };
      }
      if (server.server.getClientCapabilities()?.elicitation) {
        const ans = await server.server.elicitInput({
          message: "Place this order? You can cancel it for the next 10 minutes.",
          requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Place order" } }, required: ["approve"] },
        });
        if (ans.action !== "accept" || !ans.content?.approve) {
          audit(db, h, "confirm_declined", { proposalId }, now());
          return { content: [{ type: "text", text: "Okay, I won't order that." }], structuredContent: { view: "receipt", declined: true } };
        }
      }
      const res = await confirm(db, store, h, proposalId, now());
      if (!res.ok) return { isError: true, content: [{ type: "text", text: res.error }] };
      const r = res.receipt;
      return {
        content: [{ type: "text", text: `${res.replayed ? "That was already ordered. " : "Done. "}Order ${r.orderRef} for ${usd(r.totalCents)}. Say "undo" within 10 minutes to cancel.` }],
        structuredContent: { view: "receipt", proposalId, receipt: r, replayed: res.replayed },
      };
    },
  );

  server.registerTool(
    "undo_restock",
    {
      title: "Cancel a just-placed order",
      description: "Cancel a restock order placed through Hearth, within the 10-minute undo window.",
      inputSchema: { proposalId: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ proposalId }, extra) => {
      const r = await undo(db, store, hh(extra), proposalId, now());
      return { isError: !r.ok, content: [{ type: "text", text: r.message }], structuredContent: { view: "undo", ...r } };
    },
  );

  server.registerTool(
    "remember_preference",
    {
      title: "Remember a household preference",
      description: "Persist a preference across sessions: a monthly-style budget cap for restocks, or an item to never reorder automatically.",
      inputSchema: {
        kind: z.enum(["budget_usd", "skip_item"]),
        value: z.string().describe("A dollar amount for budget_usd, or the product key (e.g. asin:B0000A2WMH) for skip_item"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ kind, value }, extra) => {
      const h = hh(extra);
      if (kind === "budget_usd" && !(Number(value) > 0)) return { isError: true, content: [{ type: "text", text: "A budget must be a positive dollar amount." }] };
      if (kind === "budget_usd") db.prepare("INSERT OR REPLACE INTO prefs (household, key, value) VALUES (?, 'budget_usd', ?)").run(h, String(Number(value)));
      else {
        const cur = (getPref(db, h, "skip_items") ?? "").split("|").filter(Boolean);
        if (!cur.includes(value)) cur.push(value);
        db.prepare("INSERT OR REPLACE INTO prefs (household, key, value) VALUES (?, 'skip_items', ?)").run(h, cur.join("|"));
      }
      audit(db, h, "remember_preference", { kind, value }, now());
      return { content: [{ type: "text", text: kind === "budget_usd" ? `Got it. I'll keep restocks under $${Number(value).toFixed(0)}.` : "Okay, I'll leave that one out of future plans." }], structuredContent: { kind, value } };
    },
  );

  server.registerTool(
    "activity_log",
    {
      title: "What have you done for me?",
      description: "Recent actions Hearth took or proposed, newest first, for transparency.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit }, extra) => {
      const items = recentAudit(db, hh(extra), limit);
      return { content: [{ type: "text", text: items.length ? `Last action: ${items[0].action.replace(/_/g, " ")}.` : "Nothing yet." }], structuredContent: { view: "log", items } };
    },
  );

  return server;
}

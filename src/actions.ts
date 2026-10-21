import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { audit } from "./db.js";
import * as metrics from "./metrics.js";
import type { Runway } from "./forecast.js";
import { fmtMoney } from "./money.js";
import { minorDigits } from "./normalize.js";

interface Line { productKey: string; title: string; name: string; packs: number; unitPriceCents: number; currency: string; reason: string }
export interface Proposal {
  id: string; household: string; status: "pending" | "confirmed" | "expired" | "cancelled" | "undone";
  createdAt: number; expiresAt: number; currency: string; lines: Line[]; totalCents: number; budgetCents: number | null; dropped: { title: string; why: string }[];
}
export interface Receipt { orderRef: string; placedAt: number; currency: string; totalCents: number; undoUntil: number; lines: Line[] }

/** The only seam between Hearth and a real storefront. Swap this for Amazon's ordering APIs in production. */
export interface StoreAdapter {
  place(lines: Line[], idempotencyKey: string): Promise<{ orderRef: string }>;
  cancel(orderRef: string): Promise<boolean>;
}
export const simulatedStore: StoreAdapter = {
  async place(_lines, key) { return { orderRef: `SIM-${key.slice(0, 8).toUpperCase()}` }; },
  async cancel() { return true; },
};

const PROPOSAL_TTL = 30 * 60_000;
const MAX_LINES = 25;
const DAY_MS = 86_400_000;

/**
 * Hard spending ceilings, set by the operator (env), never by a tool: a prompt-injected or confused model can
 * lower its own budget but cannot raise these. Amounts are in major units of the order's currency.
 */
function spendLimits(env = process.env) {
  return { perOrder: Number(env.HEARTH_MAX_ORDER ?? 500), perDay: Number(env.HEARTH_MAX_DAILY ?? 1500) };
}
const UNDO_WINDOW = 10 * 60_000;

/** Pick what to reorder: items running out inside `withinDays`, cheapest-need-first, capped by budget. */
export function propose(db: DatabaseSync, household: string, runway: Runway[], opts: { withinDays: number; budgetCents?: number; currency?: string }, now = Date.now()): Proposal {
  const due = runway.filter((r) => r.daysLeft <= opts.withinDays).sort((a, b) => a.daysLeft - b.daysLeft);
  const currency = opts.currency ?? due[0]?.currency ?? "USD";
  const lines: Line[] = [];
  const dropped: Proposal["dropped"] = [];
  let total = 0;
  for (const r of due) {
    if (lines.length >= MAX_LINES) { dropped.push({ title: r.name, why: `plans are limited to ${MAX_LINES} items` }); continue; }
    if (r.currency !== currency) { dropped.push({ title: r.name, why: `priced in ${r.currency}; this household orders in ${currency}` }); continue; }
    // One cycle's worth, rounded to whole packs, minimum 1.
    const cycleDays = 30;
    const unitsNeeded = Math.max(1, Math.round(r.unitsPerDay * cycleDays));
    const packs = Math.max(1, Math.round(unitsNeeded / Math.max(1, r.packUnits)));
    const cost = packs * r.unitPriceCents;
    if (opts.budgetCents !== undefined && total + cost > opts.budgetCents) {
      dropped.push({ title: r.name, why: `would exceed budget by ${fmtMoney(total + cost - opts.budgetCents, currency)}` });
      continue;
    }
    total += cost;
    lines.push({
      productKey: r.productKey, title: r.title, name: r.name, packs, unitPriceCents: r.unitPriceCents, currency,
      reason: r.daysLeft < 0 ? `ran out ~${-r.daysLeft}d ago by your usual pace` : `about ${r.daysLeft}d left (±${r.windowDays})`,
    });
  }
  const p: Proposal = {
    id: `prop_${randomUUID().slice(0, 12)}`, household, status: "pending", createdAt: now, expiresAt: now + PROPOSAL_TTL, currency,
    lines, totalCents: total, budgetCents: opts.budgetCents ?? null, dropped,
  };
  db.prepare("INSERT INTO proposals (id, household, created_at, expires_at, status, payload) VALUES (?, ?, ?, ?, ?, ?)").run(
    p.id, household, now, p.expiresAt, p.status, JSON.stringify(p),
  );
  audit(db, household, "propose_restock", { id: p.id, lines: lines.length, totalCents: total }, now);
  return p;
}

function load(db: DatabaseSync, household: string, id: string): Proposal | null {
  const row = db.prepare("SELECT payload, status, expires_at FROM proposals WHERE id = ? AND household = ?").get(id, household) as
    | { payload: string; status: Proposal["status"]; expires_at: number } | undefined;
  if (!row) return null;
  return { ...(JSON.parse(row.payload) as Proposal), status: row.status };
}

export async function confirm(db: DatabaseSync, store: StoreAdapter, household: string, id: string, now = Date.now()): Promise<{ ok: true; receipt: Receipt; replayed: boolean } | { ok: false; error: string }> {
  const p = load(db, household, id);
  if (!p) return { ok: false, error: "No such proposal for this household." };
  if (p.status === "confirmed") {
    const row = db.prepare("SELECT receipt FROM proposals WHERE id = ?").get(id) as { receipt: string };
    return { ok: true, receipt: JSON.parse(row.receipt) as Receipt, replayed: true }; // idempotent
  }
  if (p.status !== "pending") return { ok: false, error: `Proposal is ${p.status}.` };
  if (now > p.expiresAt) {
    db.prepare("UPDATE proposals SET status = 'expired' WHERE id = ?").run(id);
    return { ok: false, error: "Proposal expired. Ask me to plan it again so prices are fresh." };
  }
  if (p.lines.length === 0) return { ok: false, error: "Nothing to order in this proposal." };
  const lim = spendLimits();
  const unit = 10 ** minorDigits(p.currency);
  if (p.totalCents > lim.perOrder * unit) {
    audit(db, household, "confirm_blocked", { id, reason: "per-order limit", totalCents: p.totalCents }, now);
    metrics.inc("hearth_orders_blocked_total", { reason: "per_order" });
    return { ok: false, error: `That order is over the ${fmtMoney(lim.perOrder * unit, p.currency)} per-order safety limit, so I can't place it. Ask for a smaller plan.` };
  }
  const recent = db.prepare("SELECT receipt FROM proposals WHERE household = ? AND status = 'confirmed' AND created_at > ?").all(household, now - 2 * DAY_MS) as unknown as { receipt: string }[];
  const spent24h = recent.map((r) => JSON.parse(r.receipt) as Receipt).filter((r) => r.currency === p.currency && r.placedAt > now - DAY_MS).reduce((a, r) => a + r.totalCents, 0);
  if (spent24h + p.totalCents > lim.perDay * unit) {
    audit(db, household, "confirm_blocked", { id, reason: "daily limit", spent24h }, now);
    metrics.inc("hearth_orders_blocked_total", { reason: "daily" });
    return { ok: false, error: `That would take today's total over the ${fmtMoney(lim.perDay * unit, p.currency)} daily safety limit. Try again tomorrow or order less.` };
  }
  const { orderRef } = await store.place(p.lines, id.replace("prop_", ""));
  const receipt: Receipt = { orderRef, placedAt: now, currency: p.currency, totalCents: p.totalCents, undoUntil: now + UNDO_WINDOW, lines: p.lines };
  db.prepare("UPDATE proposals SET status = 'confirmed', receipt = ? WHERE id = ?").run(JSON.stringify(receipt), id);
  audit(db, household, "confirm_restock", { id, orderRef, totalCents: p.totalCents }, now);
  return { ok: true, receipt, replayed: false };
}

export async function undo(db: DatabaseSync, store: StoreAdapter, household: string, id: string, now = Date.now()): Promise<{ ok: boolean; message: string }> {
  const p = load(db, household, id);
  if (!p) return { ok: false, message: "No such proposal for this household." };
  if (p.status !== "confirmed") return { ok: false, message: `Nothing to undo — proposal is ${p.status}.` };
  const row = db.prepare("SELECT receipt FROM proposals WHERE id = ?").get(id) as { receipt: string };
  const receipt = JSON.parse(row.receipt) as Receipt;
  if (now > receipt.undoUntil) return { ok: false, message: "The undo window has closed; this order is past the point I can cancel." };
  const done = await store.cancel(receipt.orderRef);
  if (!done) return { ok: false, message: "The store could not cancel that order." };
  db.prepare("UPDATE proposals SET status = 'undone' WHERE id = ?").run(id);
  audit(db, household, "undo_restock", { id, orderRef: receipt.orderRef }, now);
  return { ok: true, message: `Cancelled order ${receipt.orderRef}.` };
}

export function recentAudit(db: DatabaseSync, household: string, limit = 20) {
  return (db.prepare("SELECT ts, action, detail FROM audit WHERE household = ? ORDER BY id DESC LIMIT ?").all(household, limit) as unknown as { ts: number; action: string; detail: string }[]).map((r) => ({
    at: new Date(r.ts).toISOString(), action: r.action, detail: JSON.parse(r.detail),
  }));
}

/** Privacy: remove everything Hearth holds for a household. Returns row counts so the caller can say what was erased. */
export function eraseHousehold(db: DatabaseSync, household: string) {
  const del = (sql: string) => Number(db.prepare(sql).run(household).changes);
  db.exec("BEGIN");
  try {
    const out = {
      orders: del("DELETE FROM orders WHERE household = ?"),
      proposals: del("DELETE FROM proposals WHERE household = ?"),
      preferences: del("DELETE FROM prefs WHERE household = ?"),
      activity: del("DELETE FROM audit WHERE household = ?"),
      tokens: del("DELETE FROM oauth_tokens WHERE household = ?"),
    };
    db.exec("COMMIT");
    return out;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

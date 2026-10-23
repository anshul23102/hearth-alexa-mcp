import { friendlyName } from "./normalize.js";
import type { DatabaseSync } from "node:sqlite";

export interface Runway {
  productKey: string;
  title: string;
  name: string;
  purchases: number;
  unitsPerDay: number;
  lastPurchase: string;
  lastUnits: number;
  packUnits: number;
  unitPriceCents: number;
  currency: string;
  runoutDate: string;
  daysLeft: number;
  /** ± days around runoutDate that contains the typical error of past cycles. */
  windowDays: number;
  confidence: "high" | "medium" | "low";
  status: "overdue" | "this_week" | "this_month" | "ok";
}

const DAY = 86_400_000;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * DAY).toISOString().slice(0, 10);

export interface Row { ordered_at: string; title: string; qty: number; pack_units: number; unit_price_cents: number; currency: string; product_key: string; status: string }

/**
 * Consumption model: for each consecutive pair of purchases, the units bought first
 * were used up over the gap between them. The median of days-per-unit is robust to
 * stock-ups, gifts and one-off orders; the MAD tells us how much to trust it.
 * Returned lines are removed first so a refunded case does not look like supply.
 */
/** Grouping of consumable lines into one series per product, same-day lines merged. Exported so the backtest reads exactly what the forecast reads. */
export function loadSeries(db: DatabaseSync, household: string): Map<string, Row[]> {
  const rows = db
    .prepare(
      `SELECT ordered_at, title, qty * pack_units AS qty, pack_units, unit_price_cents, currency, product_key, status FROM orders
       WHERE household = ? AND kind = 'consumable' AND status != 'returned' ORDER BY ordered_at`,
    )
    .all(household) as unknown as Row[];
  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byKey.get(r.product_key) ?? [];
    const prev = list[list.length - 1];
    if (prev && prev.ordered_at === r.ordered_at) { prev.qty += r.qty; continue; }
    list.push({ ...r });
    byKey.set(r.product_key, list);
  }
  return byKey;
}

/** Days per unit (median across purchase gaps) and its spread (MAD); null when there is too little history to say anything. */
export function seriesStats(list: Row[]): { dpu: number; mad: number; rel: number } | null {
  if (list.length < 3) return null;
  const perUnit: number[] = [];
  for (let i = 1; i < list.length; i++) {
    const gap = (Date.parse(list[i].ordered_at) - Date.parse(list[i - 1].ordered_at)) / DAY;
    if (gap > 0 && list[i - 1].qty > 0) perUnit.push(gap / list[i - 1].qty);
  }
  if (perUnit.length < 2) return null;
  const dpu = median(perUnit);
  if (!(dpu > 0)) return null;
  const mad = median(perUnit.map((x) => Math.abs(x - dpu)));
  return { dpu, mad, rel: mad / dpu };
}
/**
 * The +/- window shown with every date. MAD alone is the *typical* error, which the backtest showed contains the real next purchase
 * only about half the time. For roughly normal errors about 2 x MAD is the 80th percentile, and `npm run backtest` checks the result.
 */
export const WINDOW_MAD_FACTOR = 2.1;
export const windowDaysFor = (mad: number, qty: number) => Math.max(1, Math.round(WINDOW_MAD_FACTOR * mad * qty));
export const confidenceOf = (purchases: number, rel: number): Runway["confidence"] => (purchases >= 5 && rel < 0.15 ? "high" : purchases >= 4 && rel < 0.35 ? "medium" : "low");

export function forecast(db: DatabaseSync, household: string, now = Date.now()): Runway[] {
  const today = new Date(now).toISOString().slice(0, 10);
  const out: Runway[] = [];
  for (const [key, list] of loadSeries(db, household)) {
    const stats = seriesStats(list);
    if (!stats) continue;
    const { dpu, mad, rel } = stats;
    const last = list[list.length - 1];
    const cycle = last.qty * dpu;
    const runout = addDays(last.ordered_at, Math.round(cycle));
    const daysLeft = Math.round((Date.parse(runout) - Date.parse(today)) / DAY);
    const confidence = confidenceOf(list.length, rel);
    out.push({
      productKey: key,
      title: last.title,
      name: friendlyName(last.title),
      purchases: list.length,
      unitsPerDay: Math.round((1 / dpu) * 1000) / 1000,
      lastPurchase: last.ordered_at,
      lastUnits: last.qty,
      packUnits: last.pack_units,
      unitPriceCents: last.unit_price_cents,
      currency: last.currency,
      runoutDate: runout,
      daysLeft,
      windowDays: windowDaysFor(mad, last.qty),
      confidence,
      status: daysLeft < 0 ? "overdue" : daysLeft <= 7 ? "this_week" : daysLeft <= 30 ? "this_month" : "ok",
    });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

export interface BacktestCase { product: string; k: number; errorDays: number; windowDays: number; confidence: Runway["confidence"] }

/** Rolling-origin test: at every purchase k >= 4 predict the next purchase from purchases 1..k, and compare with what happened. */
export function backtestCases(db: DatabaseSync, household: string): BacktestCase[] {
  const out: BacktestCase[] = [];
  for (const [product, list] of loadSeries(db, household)) {
    for (let k = 4; k < list.length; k++) {
      const seen = list.slice(0, k);
      const st = seriesStats(seen);
      if (!st) continue;
      const last = seen[k - 1];
      const predicted = Date.parse(last.ordered_at) + Math.round(last.qty * st.dpu) * DAY;
      out.push({ product, k, errorDays: (Date.parse(list[k].ordered_at) - predicted) / DAY, windowDays: windowDaysFor(st.mad, last.qty), confidence: confidenceOf(k, st.rel) });
    }
  }
  return out;
}

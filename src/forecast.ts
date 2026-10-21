import type { DatabaseSync } from "node:sqlite";

export interface Runway {
  productKey: string;
  title: string;
  purchases: number;
  unitsPerDay: number;
  lastPurchase: string;
  lastUnits: number;
  packUnits: number;
  unitPriceCents: number;
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

interface Row { ordered_at: string; title: string; qty: number; pack_units: number; unit_price_cents: number; product_key: string; status: string }

/**
 * Consumption model: for each consecutive pair of purchases, the units bought first
 * were used up over the gap between them. The median of days-per-unit is robust to
 * stock-ups, gifts and one-off orders; the MAD tells us how much to trust it.
 * Returned lines are removed first so a refunded case does not look like supply.
 */
export function forecast(db: DatabaseSync, household: string, now = Date.now()): Runway[] {
  const rows = db
    .prepare(
      `SELECT ordered_at, title, qty * pack_units AS qty, pack_units, unit_price_cents, product_key, status FROM orders
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

  const today = new Date(now).toISOString().slice(0, 10);
  const out: Runway[] = [];
  for (const [key, list] of byKey) {
    if (list.length < 3) continue;
    const perUnit: number[] = [];
    for (let i = 1; i < list.length; i++) {
      const gap = (Date.parse(list[i].ordered_at) - Date.parse(list[i - 1].ordered_at)) / DAY;
      if (gap > 0 && list[i - 1].qty > 0) perUnit.push(gap / list[i - 1].qty);
    }
    if (perUnit.length < 2) continue;
    const dpu = median(perUnit);
    if (!(dpu > 0)) continue;
    const mad = median(perUnit.map((x) => Math.abs(x - dpu)));
    const last = list[list.length - 1];
    const cycle = last.qty * dpu;
    const runout = addDays(last.ordered_at, Math.round(cycle));
    const daysLeft = Math.round((Date.parse(runout) - Date.parse(today)) / DAY);
    const rel = mad / dpu;
    const confidence = list.length >= 5 && rel < 0.15 ? "high" : list.length >= 4 && rel < 0.35 ? "medium" : "low";
    out.push({
      productKey: key,
      title: last.title,
      purchases: list.length,
      unitsPerDay: Math.round((1 / dpu) * 1000) / 1000,
      lastPurchase: last.ordered_at,
      lastUnits: last.qty,
      packUnits: last.pack_units,
      unitPriceCents: last.unit_price_cents,
      runoutDate: runout,
      daysLeft,
      windowDays: Math.max(1, Math.round(mad * last.qty)),
      confidence,
      status: daysLeft < 0 ? "overdue" : daysLeft <= 7 ? "this_week" : daysLeft <= 30 ? "this_month" : "ok",
    });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

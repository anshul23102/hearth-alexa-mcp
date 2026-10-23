import type { DatabaseSync } from "node:sqlite";
import { audit } from "./db.js";
import * as metrics from "./metrics.js";
import { buildMatch, scoreMatch, type RecallMatch } from "./recalls.js";
import type { RecallRecord, Region } from "./recallIndex.js";

// The proactive half of recall handling. When a notice is published, find every household that owns the
// product (an index lookup by brand, not a scan of all customers), score each with the same matcher the
// "ask" path uses, and store one alert per household and product. The caller then pushes to open sessions.

export interface AlertRow { id: number; status: string; createdAt: number; match: RecallMatch }

export function processNewRecalls(db: DatabaseSync, records: RecallRecord[], now = Date.now()): { created: number; households: Set<string>; scanned: number } {
  const households = new Set<string>();
  let created = 0;
  if (records.length === 0) return { created, households, scanned: 0 };
  const brands = (db.prepare("SELECT DISTINCT brand FROM orders WHERE kind = 'durable' AND brand != ''").all() as unknown as { brand: string }[]).map((r) => r.brand).filter((b) => b.length >= 3);
  const owners = db.prepare(
    `SELECT household, product_key, MAX(title) AS title, MAX(ordered_at) AS last FROM orders
     WHERE kind = 'durable' AND brand = ? AND status != 'returned' GROUP BY household, product_key`,
  );
  const insert = db.prepare("INSERT OR IGNORE INTO alerts (household, source, ext_id, product_key, level, score, match, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  let scanned = 0;
  db.exec("BEGIN");
  try {
    for (const r of records) {
      const hay = `${r.title} ${r.product}`.toLowerCase();
      for (const brand of brands) {
        if (!hay.includes(brand)) continue;
        for (const o of owners.all(brand) as unknown as { household: string; product_key: string; title: string; last: string }[]) {
          scanned++;
          const s = scoreMatch({ title: o.title, last: o.last }, brand, r);
          if (!s) continue;
          const m = buildMatch({ title: o.title, last: o.last, productKey: o.product_key }, r, s);
          if (insert.run(o.household, r.source, r.extId, o.product_key, m.level, s.score, JSON.stringify(m), now).changes > 0) {
            created++; households.add(o.household);
          }
        }
      }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  for (const h of households) audit(db, h, "recall_alert", { count: 1 }, now);
  if (created) metrics.inc("hearth_recall_alerts_total", undefined, created);
  return { created, households, scanned };
}

export function listAlerts(db: DatabaseSync, household: string, opts: { onlyNew?: boolean; limit?: number; regions?: Region[] } = {}): AlertRow[] {
  const rows = db
    .prepare("SELECT id, status, created_at, match FROM alerts WHERE household = ? AND (? = 0 OR status = 'new') ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(household, opts.onlyNew ? 1 : 0, Math.min(opts.limit ?? 20, 100)) as unknown as { id: number; status: string; created_at: number; match: string }[];
  const out = rows.map((r) => ({ id: r.id, status: r.status, createdAt: r.created_at, match: JSON.parse(r.match) as RecallMatch }));
  return opts.regions ? out.filter((a) => opts.regions!.includes(a.match.recall.region)) : out;
}

export function markAlertsSeen(db: DatabaseSync, household: string, ids: number[]): number {
  let n = 0;
  const upd = db.prepare("UPDATE alerts SET status = 'seen' WHERE household = ? AND id = ? AND status = 'new'");
  for (const id of ids) n += Number(upd.run(household, id).changes);
  return n;
}

export function countNewAlerts(db: DatabaseSync, household: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE household = ? AND status = 'new'").get(household) as { n: number }).n;
}

/**
 * A recall notice that reaches an owner has done nothing until the product is dealt with (CPSC's own figure: under half of recalled
 * units are ever corrected). Hearth keeps the household's progress on each match: open, stopped using it, remedy requested, resolved.
 */
export const REMEDY_STATUSES = ["stopped_using", "remedy_requested", "resolved", "not_mine"] as const;
export type RemedyStatus = (typeof REMEDY_STATUSES)[number] | "open";
const MAX_TRACKED = 500;

export function setRecallStatus(db: DatabaseSync, household: string, recallId: string, productKey: string, status: (typeof REMEDY_STATUSES)[number], now = Date.now()): { ok: true } | { ok: false; error: string } {
  const [source, extId] = recallId.split(/:(.*)/s);
  const real = extId !== undefined && db.prepare("SELECT 1 FROM recalls WHERE source = ? AND ext_id = ?").get(source, extId);
  const owned = db.prepare("SELECT 1 FROM orders WHERE household = ? AND product_key = ? LIMIT 1").get(household, productKey);
  if (!real || !owned) return { ok: false, error: "That recall and product are not a match I know about for this household." };
  const have = (db.prepare("SELECT COUNT(*) AS n FROM recall_actions WHERE household = ?").get(household) as { n: number }).n;
  const exists = db.prepare("SELECT 1 FROM recall_actions WHERE household = ? AND recall_id = ? AND product_key = ?").get(household, recallId, productKey);
  if (!exists && have >= MAX_TRACKED) return { ok: false, error: "Too many recalls are being tracked for this household." };
  db.prepare("INSERT INTO recall_actions (household, recall_id, product_key, status, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (household, recall_id, product_key) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at").run(household, recallId, productKey, status, now);
  audit(db, household, "recall_status", { recallId, productKey, status }, now);
  return { ok: true };
}

/** Attach each match's progress, and count how many are still open. */
export function withRemedy<T extends { recall: { id: string }; owned: { productKey: string } }>(db: DatabaseSync, household: string, matches: T[]): { matches: (T & { remedy: RemedyStatus })[]; open: number } {
  const rows = db.prepare("SELECT recall_id, product_key, status FROM recall_actions WHERE household = ?").all(household) as unknown as { recall_id: string; product_key: string; status: RemedyStatus }[];
  const by = new Map(rows.map((r) => [`${r.recall_id}|${r.product_key}`, r.status]));
  const out = matches.map((m) => ({ ...m, remedy: by.get(`${m.recall.id}|${m.owned.productKey}`) ?? ("open" as RemedyStatus) }));
  return { matches: out, open: out.filter((m) => m.remedy !== "resolved" && m.remedy !== "not_mine").length }; // stopping use or asking for the fix is progress, not closure
}

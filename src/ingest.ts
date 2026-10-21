import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { parseCsv } from "./csv.js";
import { audit } from "./db.js";
import { classify, normalizeStatus, packUnits, parseDate, parseMoneyCents, productKey, sameProduct } from "./normalize.js";

const HEADERS: Record<string, string[]> = {
  order_id: ["order id", "order-id", "order number", "order #", "orderid"],
  date: ["order date", "date", "ordered", "purchase date", "order placed"],
  title: ["product name", "title", "item", "description", "product", "item name"],
  asin: ["asin", "asin/isbn", "sku", "isbn"],
  qty: ["quantity", "qty", "units"],
  price: ["unit price", "item price", "price", "item subtotal", "unit price tax", "total owed", "total"],
  status: ["order status", "status", "shipment status", "item status"],
};

export interface IngestReport {
  rowsRead: number;
  imported: number;
  duplicates: number;
  skipped: { line: number; reason: string }[];
  repaired: { line: number; fix: string }[];
  dateOrder: "month-first" | "day-first" | "unambiguous";
  firstDate: string | null;
  lastDate: string | null;
  kinds: Record<string, number>;
}

function mapHeaders(header: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const norm = header.map((h) => h.trim().toLowerCase());
  for (const [field, names] of Object.entries(HEADERS)) {
    for (const n of names) {
      const i = norm.indexOf(n);
      if (i >= 0) { out[field] = i; break; }
    }
  }
  return out;
}

/** Decide whether ambiguous nn/nn/yyyy dates are day-first by looking at the whole file. */
function detectDayFirst(rows: string[][], col: number): { dayFirst: boolean; label: IngestReport["dateOrder"] } {
  let dayFirst = 0, monthFirst = 0;
  for (const r of rows) {
    const m = (r[col] ?? "").trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/);
    if (!m) continue;
    if (+m[1] > 12) dayFirst++;
    else if (+m[2] > 12) monthFirst++;
  }
  if (dayFirst > monthFirst) return { dayFirst: true, label: "day-first" };
  if (monthFirst > 0) return { dayFirst: false, label: "month-first" };
  return { dayFirst: false, label: "unambiguous" };
}

export function ingestOrders(db: DatabaseSync, household: string, csv: string, now = Date.now()): IngestReport {
  const all = parseCsv(csv);
  const report: IngestReport = {
    rowsRead: 0, imported: 0, duplicates: 0, skipped: [], repaired: [],
    dateOrder: "unambiguous", firstDate: null, lastDate: null, kinds: {},
  };
  if (all.length < 2) { report.skipped.push({ line: 1, reason: "no data rows" }); return report; }

  const cols = mapHeaders(all[0]);
  if (cols.title === undefined || cols.date === undefined) {
    report.skipped.push({ line: 1, reason: "could not find product title and order date columns" });
    return report;
  }
  const rows = all.slice(1);
  const { dayFirst, label } = detectDayFirst(rows, cols.date);
  report.dateOrder = label;

  // Canonical identity: ASIN when the export has one (survives retitled listings),
  // otherwise reuse an existing key whose title words overlap enough.
  const known = new Map<string, string>(
    (db.prepare("SELECT DISTINCT product_key FROM orders WHERE household = ?").all(household) as unknown as { product_key: string }[]).map((r) => [r.product_key, r.product_key]),
  );
  const resolveKey = (asin: string | null, titleKey: string): string => {
    if (asin && /^[A-Z0-9]{10}$/i.test(asin)) return `asin:${asin.toUpperCase()}`;
    for (const k of known.keys()) if (!k.startsWith("asin:") && sameProduct(k, titleKey)) return k;
    known.set(titleKey, titleKey);
    return titleKey;
  };

  const insert = db.prepare(
    `INSERT OR IGNORE INTO orders
     (household, order_id, ordered_at, title, asin, qty, pack_units, unit_price_cents, status, product_key, kind, dedupe)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec("BEGIN");
  try {
    rows.forEach((r, idx) => {
      const line = idx + 2;
      report.rowsRead++;
      const title = (r[cols.title] ?? "").replace(/\s+/g, " ").trim();
      if (!title) return void report.skipped.push({ line, reason: "empty product title" });
      const date = parseDate(r[cols.date] ?? "", dayFirst);
      if (!date) return void report.skipped.push({ line, reason: `unreadable date "${r[cols.date] ?? ""}"` });

      let qty = cols.qty !== undefined ? parseInt((r[cols.qty] ?? "").replace(/[^\d]/g, ""), 10) : 1;
      if (!Number.isFinite(qty) || qty < 1) {
        qty = 1;
        report.repaired.push({ line, fix: "missing quantity, assumed 1" });
      }
      let price = cols.price !== undefined ? parseMoneyCents(r[cols.price] ?? "") : null;
      if (price === null) {
        price = 0;
        report.repaired.push({ line, fix: "missing price, stored as 0" });
      }
      const status = normalizeStatus(cols.status !== undefined ? r[cols.status] ?? "" : "");
      if (status === "cancelled") return void report.skipped.push({ line, reason: "cancelled order" });

      const orderId = (cols.order_id !== undefined ? r[cols.order_id] : "")?.trim() || `row-${line}`;
      const kind = classify(title);
      const titleKey = productKey(title);
      if (!titleKey) return void report.skipped.push({ line, reason: "title has no usable product words" });
      const asin = cols.asin !== undefined ? (r[cols.asin] ?? "").trim() || null : null;
      const key = resolveKey(asin, titleKey);
      const dedupe = createHash("sha1").update(`${orderId}|${key}|${date}|${qty}`).digest("hex").slice(0, 20);
      const res = insert.run(
        household, orderId, date, title, asin,
        qty, packUnits(title), price, status, key, kind, dedupe,
      );
      if (res.changes === 0) { report.duplicates++; return; }
      report.imported++;
      report.kinds[kind] = (report.kinds[kind] ?? 0) + 1;
      if (!report.firstDate || date < report.firstDate) report.firstDate = date;
      if (!report.lastDate || date > report.lastDate) report.lastDate = date;
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  audit(db, household, "import_orders", { imported: report.imported, duplicates: report.duplicates, skipped: report.skipped.length }, now);
  return report;
}

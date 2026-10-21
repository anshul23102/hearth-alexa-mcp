import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { CsvStream, parseCsv } from "./csv.js";
import { audit } from "./db.js";
import { classify, normalizeStatus, packUnits, parseCurrency, parseDate, productKey, sameProduct, toMinor } from "./normalize.js";

const HEADERS: Record<string, string[]> = {
  order_id: ["order id", "order-id", "order number", "order #", "orderid"],
  date: ["order date", "date", "ordered", "purchase date", "order placed"],
  title: ["product name", "title", "item", "description", "product", "item name"],
  asin: ["asin", "asin/isbn", "sku", "isbn"],
  qty: ["quantity", "qty", "units"],
  price: ["unit price", "item price", "price", "item subtotal", "unit price tax", "total owed", "total"],
  status: ["order status", "status", "shipment status", "item status"],
  currency: ["currency", "currency code"],
};
const SAMPLE_LIMIT = 50;
const DETECT_ROWS = 2000;
const BATCH = 20_000;

export interface IngestReport {
  rowsRead: number;
  imported: number;
  duplicates: number;
  skipped: { line: number; reason: string }[];
  skippedCount: number;
  repaired: { line: number; fix: string }[];
  repairedCount: number;
  dateOrder: "month-first" | "day-first" | "unambiguous";
  firstDate: string | null;
  lastDate: string | null;
  kinds: Record<string, number>;
  currencies: Record<string, number>;
  truncated: boolean;
}

function mapHeaders(header: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const norm = header.map((h) => h.trim().toLowerCase());
  for (const [field, names] of Object.entries(HEADERS)) {
    for (const n of names) { const i = norm.indexOf(n); if (i >= 0) { out[field] = i; break; } }
  }
  return out;
}

function detectDayFirst(rows: string[][], col: number): { dayFirst: boolean; label: IngestReport["dateOrder"] } {
  let dayFirst = 0, monthFirst = 0;
  for (const r of rows) {
    const m = (r[col] ?? "").trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/);
    if (!m) continue;
    if (+m[1] > 12) dayFirst++; else if (+m[2] > 12) monthFirst++;
  }
  if (dayFirst > monthFirst) return { dayFirst: true, label: "day-first" };
  if (monthFirst > 0) return { dayFirst: false, label: "month-first" };
  return { dayFirst: false, label: "unambiguous" };
}

/**
 * Row-at-a-time importer shared by the in-memory path (MCP tool) and the streaming path (bulk upload).
 * Never throws on bad data: every problem becomes a counted, sampled report entry.
 */
export class OrderImporter {
  readonly report: IngestReport = {
    rowsRead: 0, imported: 0, duplicates: 0, skipped: [], skippedCount: 0, repaired: [], repairedCount: 0,
    dateOrder: "unambiguous", firstDate: null, lastDate: null, kinds: {}, currencies: {}, truncated: false,
  };
  private cols: Record<string, number> = {};
  private dayFirst = false;
  private known = new Map<string, true>();
  private insert;
  private inTx = false;
  private sinceCommit = 0;
  ready = false;

  constructor(private db: DatabaseSync, private household: string, private now = Date.now()) {
    for (const r of db.prepare("SELECT DISTINCT product_key FROM orders WHERE household = ?").all(household) as unknown as { product_key: string }[]) this.known.set(r.product_key, true);
    this.insert = db.prepare(
      `INSERT OR IGNORE INTO orders
       (household, order_id, ordered_at, title, asin, qty, pack_units, unit_price_cents, currency, status, product_key, kind, dedupe)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /** Returns false when the file cannot be understood at all. */
  begin(header: string[], sampleRows: string[][]): boolean {
    this.cols = mapHeaders(header);
    if (this.cols.title === undefined || this.cols.date === undefined) { this.skip(1, "could not find product title and order date columns"); return false; }
    const d = detectDayFirst(sampleRows, this.cols.date);
    this.dayFirst = d.dayFirst; this.report.dateOrder = d.label;
    this.ready = true;
    this.db.exec("BEGIN"); this.inTx = true;
    return true;
  }

  private skip(line: number, reason: string) { this.report.skippedCount++; if (this.report.skipped.length < SAMPLE_LIMIT) this.report.skipped.push({ line, reason }); }
  private repair(line: number, fix: string) { this.report.repairedCount++; if (this.report.repaired.length < SAMPLE_LIMIT) this.report.repaired.push({ line, fix }); }

  private resolveKey(asin: string | null, titleKey: string): string {
    if (asin && /^[A-Z0-9]{10}$/i.test(asin)) return `asin:${asin.toUpperCase()}`;
    if (this.known.has(titleKey)) return titleKey;
    for (const k of this.known.keys()) if (!k.startsWith("asin:") && sameProduct(k, titleKey)) return k;
    this.known.set(titleKey, true);
    return titleKey;
  }

  add(r: string[], line: number) {
    const c = this.cols;
    this.report.rowsRead++;
    const title = (r[c.title] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!title) return this.skip(line, "empty product title");
    const date = parseDate(r[c.date] ?? "", this.dayFirst);
    if (!date) return this.skip(line, `unreadable date "${(r[c.date] ?? "").slice(0, 30)}"`);

    let qty = c.qty !== undefined ? parseInt((r[c.qty] ?? "").replace(/[^\d]/g, ""), 10) : 1;
    if (!Number.isFinite(qty) || qty < 1) { qty = 1; this.repair(line, "missing quantity, assumed 1"); }
    if (qty > 10_000) { qty = 1; this.repair(line, "implausible quantity, assumed 1"); }

    const rawPrice = c.price !== undefined ? r[c.price] ?? "" : "";
    const currency = (c.currency !== undefined ? parseCurrency(r[c.currency] ?? "") : null) ?? parseCurrency(rawPrice) ?? "USD";
    let price = c.price !== undefined ? toMinor(rawPrice, currency) : null;
    if (price === null || price < 0) { price = 0; this.repair(line, "missing price, stored as 0"); }

    const status = normalizeStatus(c.status !== undefined ? r[c.status] ?? "" : "");
    if (status === "cancelled") return this.skip(line, "cancelled order");

    const orderId = ((c.order_id !== undefined ? r[c.order_id] : "") ?? "").trim().slice(0, 60) || `row-${line}`;
    const kind = classify(title);
    const titleKey = productKey(title);
    if (!titleKey) return this.skip(line, "title has no usable product words");
    const asinRaw = c.asin !== undefined ? (r[c.asin] ?? "").trim().slice(0, 20) || null : null;
    const key = this.resolveKey(asinRaw, titleKey);
    const dedupe = createHash("sha1").update(`${orderId}|${key}|${date}|${qty}`).digest("hex").slice(0, 20);
    const res = this.insert.run(this.household, orderId, date, title, asinRaw, qty, packUnits(title), price, currency, status, key, kind, dedupe);
    if (res.changes === 0) { this.report.duplicates++; return; }
    this.report.imported++;
    this.report.kinds[kind] = (this.report.kinds[kind] ?? 0) + 1;
    this.report.currencies[currency] = (this.report.currencies[currency] ?? 0) + 1;
    if (!this.report.firstDate || date < this.report.firstDate) this.report.firstDate = date;
    if (!this.report.lastDate || date > this.report.lastDate) this.report.lastDate = date;
    if (++this.sinceCommit >= BATCH) { this.db.exec("COMMIT; BEGIN"); this.sinceCommit = 0; }
  }

  finish(): IngestReport {
    if (this.inTx) { this.db.exec("COMMIT"); this.inTx = false; }
    audit(this.db, this.household, "import_orders", { imported: this.report.imported, duplicates: this.report.duplicates, skipped: this.report.skippedCount }, this.now);
    return this.report;
  }
  abort() { if (this.inTx) { try { this.db.exec("ROLLBACK"); } catch { /* already closed */ } this.inTx = false; } }
}

/** Whole-file path used by the MCP tool. */
export function ingestOrders(db: DatabaseSync, household: string, csv: string, now = Date.now()): IngestReport {
  const all = parseCsv(csv);
  const imp = new OrderImporter(db, household, now);
  if (all.length < 2) { imp.report.skippedCount++; imp.report.skipped.push({ line: 1, reason: "no data rows" }); return imp.report; }
  if (!imp.begin(all[0], all.slice(1, DETECT_ROWS + 1))) return imp.report;
  try { all.slice(1).forEach((r, i) => imp.add(r, i + 2)); } catch (e) { imp.abort(); throw e; }
  return imp.finish();
}

export interface StreamLimits { maxBytes?: number; maxRows?: number }

/**
 * Streaming path for large uploads. Memory stays flat: rows are parsed as chunks arrive and committed
 * in batches. The first DETECT_ROWS rows are held back once to decide day-first vs month-first dates.
 */
export async function ingestStream(
  db: DatabaseSync, household: string, source: AsyncIterable<Uint8Array | string>,
  { maxBytes = 250 * 1024 * 1024, maxRows = 2_000_000 }: StreamLimits = {}, now = Date.now(),
): Promise<IngestReport> {
  const imp = new OrderImporter(db, household, now);
  const csv = new CsvStream();
  const dec = new TextDecoder("utf-8", { fatal: false });
  let header: string[] | null = null;
  let held: string[][] = [];
  let line = 1, bytes = 0, stop = false;

  const handle = (rows: string[][]) => {
    for (const r of rows) {
      if (stop) return;
      if (!header) { header = r; line++; continue; }
      if (!imp.ready) {
        held.push(r);
        if (held.length >= DETECT_ROWS) flush();
        continue;
      }
      if (imp.report.rowsRead >= maxRows) { stop = true; imp.report.truncated = true; return; }
      imp.add(r, ++line);
    }
  };
  const flush = () => {
    if (!header || imp.ready) return;
    if (!imp.begin(header, held)) { stop = true; held = []; return; }
    for (const r of held) { if (imp.report.rowsRead >= maxRows) { stop = true; imp.report.truncated = true; break; } imp.add(r, ++line); }
    held = [];
  };

  try {
    for await (const chunk of source) {
      bytes += typeof chunk === "string" ? chunk.length : chunk.byteLength;
      if (bytes > maxBytes) { imp.report.truncated = true; break; }
      handle(csv.push(typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true })));
      if (stop) break;
    }
    handle(csv.end());
    flush();
  } catch (e) { imp.abort(); throw e; }
  if (!imp.ready) return imp.report;
  return imp.finish();
}

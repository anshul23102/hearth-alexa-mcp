import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { brandOf } from "./normalize.js";

export function openDb(path = process.env.HEARTH_DB ?? "data/hearth.db"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") { try { chmodSync(path, 0o600); } catch { /* read-only mount or foreign owner: leave as is */ } } // order history is personal data: owner-only
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household TEXT NOT NULL,
      order_id TEXT NOT NULL,
      ordered_at TEXT NOT NULL,
      title TEXT NOT NULL,
      asin TEXT,
      qty INTEGER NOT NULL,
      pack_units INTEGER NOT NULL DEFAULT 1,
      unit_price_cents INTEGER NOT NULL, -- minor units of the currency column (cents, pence, whole yen)
      currency TEXT NOT NULL DEFAULT 'USD',
      brand TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      product_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      dedupe TEXT NOT NULL,
      UNIQUE (household, dedupe)
    );
    CREATE INDEX IF NOT EXISTS orders_key ON orders (household, product_key);
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      household TEXT NOT NULL,
      source TEXT NOT NULL,
      ext_id TEXT NOT NULL,
      product_key TEXT NOT NULL,
      level TEXT NOT NULL,
      score INTEGER NOT NULL,
      match TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at INTEGER NOT NULL,
      UNIQUE (household, product_key, source, ext_id)
    );
    CREATE INDEX IF NOT EXISTS alerts_hh ON alerts (household, status, created_at);
    CREATE TABLE IF NOT EXISTS recall_actions (
      household TEXT NOT NULL,
      recall_id TEXT NOT NULL,
      product_key TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (household, recall_id, product_key)
    );
    CREATE TABLE IF NOT EXISTS recalls (
      source TEXT NOT NULL,
      ext_id TEXT NOT NULL,
      region TEXT NOT NULL,
      date TEXT NOT NULL,
      title TEXT NOT NULL,
      product TEXT NOT NULL,
      text TEXT NOT NULL,
      url TEXT NOT NULL,
      hazard TEXT NOT NULL,
      remedy TEXT NOT NULL,
      image TEXT,
      search TEXT NOT NULL,
      PRIMARY KEY (source, ext_id)
    );
    CREATE INDEX IF NOT EXISTS recalls_region_date ON recalls (region, date);
    CREATE TABLE IF NOT EXISTS recall_sync (
      source TEXT PRIMARY KEY,
      synced_at INTEGER NOT NULL,
      count INTEGER NOT NULL,
      mode TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      household TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      receipt TEXT
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      household TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY,
      redirect_uris TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      client_id TEXT NOT NULL,
      household TEXT NOT NULL,
      exp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS oauth_tokens_hh ON oauth_tokens (household, client_id);
    CREATE TABLE IF NOT EXISTS prefs (
      household TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (household, key)
    );
  `);
  const cols = (db.prepare("PRAGMA table_info(orders)").all() as unknown as { name: string }[]).map((c) => c.name);
  if (!cols.includes("currency")) db.exec("ALTER TABLE orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
  const pcols = (db.prepare("PRAGMA table_info(proposals)").all() as unknown as { name: string }[]).map((c) => c.name);
  if (!pcols.includes("approval_hash")) db.exec("ALTER TABLE proposals ADD COLUMN approval_hash TEXT; ALTER TABLE proposals ADD COLUMN approval_attempts INTEGER NOT NULL DEFAULT 0");
  const acols = (db.prepare("PRAGMA table_info(audit)").all() as unknown as { name: string }[]).map((c) => c.name);
  if (!acols.includes("hash")) db.exec("ALTER TABLE audit ADD COLUMN seq INTEGER; ALTER TABLE audit ADD COLUMN prev_hash TEXT; ALTER TABLE audit ADD COLUMN hash TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS audit_chain ON audit (household, seq) WHERE seq IS NOT NULL");
  if (!cols.includes("brand")) {
    db.exec("ALTER TABLE orders ADD COLUMN brand TEXT NOT NULL DEFAULT ''");
    const upd = db.prepare("UPDATE orders SET brand = ? WHERE id = ?");
    for (const r of db.prepare("SELECT id, title FROM orders WHERE kind = 'durable'").all() as unknown as { id: number; title: string }[]) upd.run(brandOf(r.title).toLowerCase(), r.id);
  }
  // Reverse lookup (recall -> owners) goes through this index, so it works at millions of households.
  db.exec("CREATE INDEX IF NOT EXISTS orders_brand ON orders (brand) WHERE kind = 'durable'");
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  return db;
}

const link = (prev: string, seq: number, ts: number, household: string, action: string, detail: string) =>
  createHash("sha256").update(`${prev}|${seq}|${ts}|${household}|${action}|${detail}`).digest("hex");

/**
 * Append to a household's audit log. Entries form a hash chain (each commits to the one before it), so editing or
 * deleting history is detectable with verifyAudit. A UNIQUE (household, seq) index keeps the chain linear even when
 * two connections (request thread and import worker) write at the same moment: the loser retries.
 */
export function audit(db: DatabaseSync, household: string, action: string, detail: unknown, now = Date.now()) {
  const text = JSON.stringify(detail);
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = db.prepare("SELECT seq, hash FROM audit WHERE household = ? AND seq IS NOT NULL ORDER BY seq DESC LIMIT 1").get(household) as { seq: number; hash: string } | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prev = last?.hash ?? "genesis";
    try {
      db.prepare("INSERT INTO audit (ts, household, action, detail, seq, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)").run(now, household, action, text, seq, prev, link(prev, seq, now, household, action, text));
      return;
    } catch (e) { if (!/UNIQUE/.test((e as Error).message)) throw e; }
  }
  throw new Error("audit chain contention");
}

/** Recompute the chain. `ok: false` names the first sequence number that was altered or is missing. */
/** The newest entry's number and hash: a short fingerprint of the whole history, because every hash covers everything before it. */
export function auditHead(db: DatabaseSync, household: string): { seq: number; hash: string } | null {
  return (db.prepare("SELECT seq, hash FROM audit WHERE household = ? AND seq IS NOT NULL ORDER BY seq DESC LIMIT 1").get(household) as { seq: number; hash: string } | undefined) ?? null;
}

/**
 * Has the history changed since someone wrote down a fingerprint? A chain verified only against itself cannot catch someone who
 * rewrites every hash consistently; a fingerprint kept outside the database can. "missing" means entries were deleted.
 */
export function auditPin(db: DatabaseSync, household: string, seq: number, hash: string): "unchanged" | "changed" | "missing" {
  const row = db.prepare("SELECT hash FROM audit WHERE household = ? AND seq = ?").get(household, seq) as { hash: string } | undefined;
  return !row ? "missing" : row.hash === hash ? "unchanged" : "changed";
}
export function verifyAudit(db: DatabaseSync, household: string): { ok: boolean; entries: number; brokenAt?: number } {
  const rows = db.prepare("SELECT seq, ts, action, detail, prev_hash, hash FROM audit WHERE household = ? AND seq IS NOT NULL ORDER BY seq").all(household) as unknown as { seq: number; ts: number; action: string; detail: string; prev_hash: string; hash: string }[];
  let prev = "genesis", expect = 1;
  for (const r of rows) {
    if (r.seq !== expect || r.prev_hash !== prev || r.hash !== link(prev, r.seq, r.ts, household, r.action, r.detail)) return { ok: false, entries: rows.length, brokenAt: expect };
    prev = r.hash; expect++;
  }
  return { ok: true, entries: rows.length };
}

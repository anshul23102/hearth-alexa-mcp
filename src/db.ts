import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path = process.env.HEARTH_DB ?? "data/hearth.db"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
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
      status TEXT NOT NULL,
      product_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      dedupe TEXT NOT NULL,
      UNIQUE (household, dedupe)
    );
    CREATE INDEX IF NOT EXISTS orders_key ON orders (household, product_key);
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
  return db;
}

export function audit(db: DatabaseSync, household: string, action: string, detail: unknown, now = Date.now()) {
  db.prepare("INSERT INTO audit (ts, household, action, detail) VALUES (?, ?, ?, ?)").run(
    now,
    household,
    action,
    JSON.stringify(detail),
  );
}

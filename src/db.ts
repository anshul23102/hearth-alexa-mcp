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
      unit_price_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      product_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      dedupe TEXT NOT NULL,
      UNIQUE (household, dedupe)
    );
    CREATE INDEX IF NOT EXISTS orders_key ON orders (household, product_key);
    CREATE TABLE IF NOT EXISTS recall_cache (
      query TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      body TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS prefs (
      household TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (household, key)
    );
  `);
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

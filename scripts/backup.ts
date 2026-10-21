// Online backup of the live database (safe while the server is running): npm run backup -- backups/hearth-$(date +%F).db
import { backup } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { openDb } from "../src/db.js";

export async function backupDb(src: string, dest: string): Promise<{ bytes: number; orders: number; households: number; integrity: string }> {
  mkdirSync(dirname(dest), { recursive: true });
  const db = openDb(src);
  try { await backup(db, dest); } finally { db.close(); }
  // Verify what we wrote, not what we meant to write.
  const copy = openDb(dest);
  try {
    const integrity = (copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    const orders = (copy.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
    const households = (copy.prepare("SELECT COUNT(DISTINCT household) AS n FROM orders").get() as { n: number }).n;
    return { bytes: statSync(dest).size, orders, households, integrity };
  } finally { copy.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dest = process.argv[2];
  if (!dest) { console.error("usage: npm run backup -- <destination.db>"); process.exit(1); }
  const r = await backupDb(process.env.HEARTH_DB ?? "data/hearth.db", dest);
  console.log(`backup written: ${dest} (${(r.bytes / 1e6).toFixed(1)} MB, ${r.orders.toLocaleString()} orders, ${r.households.toLocaleString()} households, integrity: ${r.integrity})`);
  if (r.integrity !== "ok") process.exit(2);
}

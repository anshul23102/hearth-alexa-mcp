// Shows what the sample households actually contain, in plain numbers, so anyone can judge whether they look like real shopping:
// what each product costs, how often it is bought, how long one pack lasts at that pace, and when it runs out.   npm run audit:data
import { generateSample, SAMPLE_FILES } from "../src/sample.js";
import { openDb } from "../src/db.js";
import { ingestOrders } from "../src/ingest.js";
import { forecast } from "../src/forecast.js";
import { fmtMoney } from "../src/money.js";

const today = new Date().toISOString().slice(0, 10);
for (const file of SAMPLE_FILES) {
  const db = openDb(":memory:");
  const r = ingestOrders(db, "h", generateSample(file, today));
  const cur = Object.keys(r.currencies)[0];
  console.log(`\n${file}  (${cur}, dates ${r.dateOrder}; ${r.rowsRead} rows read, ${r.imported} kept, ${r.duplicates} duplicates, ${r.skippedCount} unreadable, ${r.firstDate} to ${r.lastDate})`);
  console.log("  " + "product".padEnd(26) + "price".padStart(11) + "orders".padStart(8) + "  a pack lasts".padEnd(16) + "runs out".padEnd(16) + "window");
  for (const i of forecast(db, "h")) {
    const lasts = Math.round(i.packUnits / i.unitsPerDay);
    const when = i.daysLeft < 0 ? `${-i.daysLeft} d overdue` : `in ${i.daysLeft} d`;
    console.log("  " + i.name.slice(0, 25).padEnd(26) + fmtMoney(i.unitPriceCents, i.currency).padStart(11) + String(i.purchases).padStart(8) + `  ~${lasts} days`.padEnd(16) + when.padEnd(16) + `±${i.windowDays} d (${i.confidence})`);
  }
  const durables = db.prepare("SELECT title, ordered_at, unit_price_cents, currency FROM orders WHERE kind = 'durable' ORDER BY ordered_at").all() as unknown as { title: string; ordered_at: string; unit_price_cents: number; currency: string }[];
  console.log("  appliances: " + durables.map((d) => `${d.title.split(" ").slice(0, 3).join(" ")} ${fmtMoney(d.unit_price_cents, d.currency)} (${d.ordered_at})`).join("; "));
}

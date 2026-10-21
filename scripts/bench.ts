// Scale benchmark. Usage: npx tsx scripts/bench.ts [households=5000] [ordersPerHousehold=200]
// Writes a throwaway SQLite file, imports synthetic households through the production importer, then
// measures per-household forecast and recall-check latency against the full (real) recall index.
import { rmSync, statSync } from "node:fs";
import { openDb } from "../src/db.js";
import { ingestOrders } from "../src/ingest.js";
import { forecast } from "../src/forecast.js";
import { checkRecalls } from "../src/recalls.js";
import { syncRecalls, recallStats } from "../src/recallIndex.js";

const H = Number(process.argv[2] ?? 5000);
const PER = Number(process.argv[3] ?? 200);
const path = process.env.BENCH_DB ?? "/tmp/hearth-bench.db";
for (const ext of ["", "-wal", "-shm"]) rmSync(path + ext, { force: true });
const db = openDb(path);

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const DAY = 86_400_000;

const CONSUMABLES = ["Bounty Paper Towels 12 Triple Rolls", "Charmin Toilet Paper 18 Mega Rolls", "Tide PODS Laundry Detergent 81 Count", "Cascade Dishwasher Detergent Pods 62 Count", "Glad Trash Bags 80 Count", "Kirkland Dog Food 35 lb", "Nespresso Coffee Pods 50 Count", "Nature Made Vitamin D3 220 Softgels", "Colgate Toothpaste 4 Pack", "Pampers Diapers 120 Count", "Huggies Wipes 560 Count", "Dawn Dish Soap 38 oz"];
const DURABLES = ["Ninja Foodi 6.5 Qt Pressure Cooker OP302", "Cuisinart Compact Blender & Juice Extractor Combo", "Dyson V8 Cordless Vacuum", "Instant Pot Duo 7-in-1 DUO60", "Honeywell Space Heater HHF360", "Philips Sonicare 4100", "Secura Air Fryer 5.8 Qt", "BlendJet 2 Portable Blender", "Insignia Digital Air Fryer", "KitchenAid Stand Mixer KSM150"];
const CURR: [string, (n: number) => string][] = [["USD", (n) => `$${n.toFixed(2)}`], ["GBP", (n) => `£${n.toFixed(2)}`], ["INR", (n) => `₹${Math.round(n * 80)}`], ["EUR", (n) => `${n.toFixed(2).replace(".", ",")} €`]];
const DATES: ((d: Date) => string)[] = [(d) => d.toISOString().slice(0, 10), (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`, (d) => `${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}`];

function household(anchor: number): string {
  const [, fmtMoney] = pick(CURR);
  const fmtDate = DATES[0];
  const rows = ["Order ID,Order Date,Product Name,ASIN,Quantity,Unit Price,Order Status"];
  const items = Array.from({ length: 6 }, () => ({ t: pick(CONSUMABLES), gap: 14 + Math.floor(rnd() * 60), price: 5 + rnd() * 40, asin: "B0" + Math.floor(rnd() * 1e8).toString(36).toUpperCase().padStart(8, "0").slice(0, 8) }));
  let n = 0;
  for (const it of items) {
    for (let t = anchor - 730 * DAY; t < anchor - 2 * DAY && rows.length < PER; t += (it.gap + Math.floor(rnd() * 8) - 4) * DAY) {
      const status = rnd() < 0.04 ? "Cancelled" : "Delivered";
      const line = `"${++n}-${rows.length}","${fmtDate(new Date(t))}","${it.t}",${it.asin},1,"${fmtMoney(it.price)}",${status}`;
      rows.push(line); if (rnd() < 0.03) rows.push(line);
    }
  }
  for (let i = 0; i < 3; i++) rows.push(`"d${i}","${fmtDate(new Date(anchor - Math.floor(rnd() * 900) * DAY))}","${pick(DURABLES)}",B0${Math.floor(rnd() * 1e8).toString(36).toUpperCase().padStart(8, "0").slice(0, 8)},1,"$99.00",Delivered`);
  return rows.join("\n");
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const ms = (x: number) => `${x.toFixed(2)} ms`;

let t0 = performance.now();
const sync = await syncRecalls(db);
console.log(`recall index: ${sync.map((s) => `${s.source}=${s.count} (${s.mode})`).join(", ")} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const anchor = Date.parse("2026-10-21");
t0 = performance.now();
let rows = 0, imported = 0;
for (let i = 0; i < H; i++) {
  const r = ingestOrders(db, `hh_${i}`, household(anchor));
  rows += r.rowsRead; imported += r.imported;
}
const importS = (performance.now() - t0) / 1000;
console.log(`import: ${H} households, ${rows.toLocaleString()} rows read, ${imported.toLocaleString()} stored in ${importS.toFixed(1)}s = ${Math.round(rows / importS).toLocaleString()} rows/s`);

const sample = Array.from({ length: Math.min(1000, H) }, () => `hh_${Math.floor(rnd() * H)}`);
const fc: number[] = [], rc: number[] = []; let matches = 0, likely = 0;
for (const h of sample) {
  let a = performance.now(); forecast(db, h, anchor); fc.push(performance.now() - a);
  a = performance.now(); const r = await checkRecalls(db, h, anchor); rc.push(performance.now() - a); matches += r.matches.length; likely += r.matches.filter((m) => m.level === "likely").length;
}
console.log(`forecast per household (n=${sample.length}): p50 ${ms(pct(fc, 0.5))}  p95 ${ms(pct(fc, 0.95))}  p99 ${ms(pct(fc, 0.99))}`);
console.log(`recall check per household: p50 ${ms(pct(rc, 0.5))}  p95 ${ms(pct(rc, 0.95))}  p99 ${ms(pct(rc, 0.99))}  (${matches} matches, ${likely} likely, across ${sample.length} households)`);
const tot = (db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
console.log(`db: ${tot.toLocaleString()} order rows, ${(statSync(path).size / 1e6).toFixed(0)} MB; recalls ${recallStats(db).map((s) => s.n).join("+")}`);

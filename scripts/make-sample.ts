// Generates data/sample-orders.csv: a SYNTHETIC but deliberately messy order export.
// Every flaw below is one we have seen in real exports: mixed date formats, currency
// symbols, duplicated rows, cancelled/returned lines, missing quantities, and the same
// product retitled between purchases.
import { writeFileSync } from "node:fs";

let seed = 20261021;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const jitter = (n: number, pct: number) => Math.round(n * (1 + (rnd() * 2 - 1) * pct));
const DAY = 86_400_000;
const anchor = Date.parse(process.argv[2] ?? new Date().toISOString().slice(0, 10));

type Item = { titles: string[]; gap: number; price: number; qty?: number };
const consumables: Item[] = [
  { titles: ["Bounty Select-A-Size Paper Towels, 12 Triple Rolls", "BOUNTY Paper Towels Select a Size 12 Triple Rolls Family Pack"], gap: 21, price: 2699 },
  { titles: ["Charmin Ultra Soft Toilet Paper, 18 Mega Rolls", "Charmin Ultra Soft Toilet Paper 18 Mega Rolls = 90 Regular"], gap: 28, price: 2449 },
  { titles: ["Tide PODS Laundry Detergent Soap Pacs, 81 Count"], gap: 38, price: 2197 },
  { titles: ["Cascade Platinum Dishwasher Detergent Pods, 62 Count"], gap: 33, price: 1899 },
  { titles: ["Glad ForceFlex Tall Kitchen Trash Bags, 80 Count"], gap: 45, price: 1649 },
  { titles: ["Kirkland Signature Organic Dog Food Chicken 35 lb", "Kirkland Organic Dog Food Chicken, 35 Pound Bag"], gap: 24, price: 3299 },
  { titles: ["Nespresso Original Capsules Coffee Pods, 50 Count"], gap: 17, price: 3500 },
  { titles: ["Nature Made Vitamin D3 2000 IU, 220 Softgels"], gap: 110, price: 1399 },
  { titles: ["Colgate Total Toothpaste, 4 Pack"], gap: 62, price: 1599 },
];
const durables = [
  { title: "Ninja Foodi 6.5 Qt Pressure Cooker Steam Fryer OP302", daysAgo: 540, price: 15999 },
  { title: "Cuisinart Compact Blender & Juice Extractor Combo", daysAgo: 1100, price: 8999 },
  { title: "Dyson V8 Cordless Vacuum Cleaner", daysAgo: 400, price: 34999 },
  { title: "Philips Sonicare ProtectiveClean 4100 Rechargeable Toothbrush", daysAgo: 220, price: 6995 },
];

const FORMATS = [
  (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`,
  (d: Date) => d.toISOString().slice(0, 10),
  (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
];
const money = (c: number) => (rnd() < 0.25 ? `USD ${(c / 100).toFixed(2)}` : rnd() < 0.5 ? `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : (c / 100).toFixed(2));
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

const rows: string[] = ["Order ID,Order Date,Product Name,ASIN,Quantity,Unit Price,Order Status"];
let n = 0;
const oid = () => `114-${String(7000000 + ++n * 137).padStart(7, "0")}-${String(1000000 + n * 91).padStart(7, "0")}`;
const asin = () => "B0" + Math.floor(rnd() * 1e8).toString(36).toUpperCase().padStart(8, "0").slice(0, 8);

for (const it of consumables) {
  let t = anchor - 24 * 30 * DAY * 1 - Math.floor(rnd() * it.gap) * DAY;
  const a = asin();
  while (t < anchor - 2 * DAY) {
    const d = new Date(t);
    const fmt = FORMATS[Math.floor(rnd() * FORMATS.length)];
    const qty = rnd() < 0.12 ? 2 : 1;
    const status = rnd() < 0.04 ? "Cancelled" : rnd() < 0.03 ? "Returned" : "Delivered";
    const line = [oid(), q(fmt(d)), q(it.titles[Math.floor(rnd() * it.titles.length)]), a, rnd() < 0.05 ? "" : String(qty), q(money(jitter(it.price, 0.03))), status].join(",");
    rows.push(line);
    if (rnd() < 0.04) rows.push(line); // exact duplicate row
    t += jitter(it.gap * qty, 0.18) * DAY;
  }
}
for (const d of durables) {
  rows.push([oid(), q(FORMATS[1](new Date(anchor - d.daysAgo * DAY))), q(d.title), asin(), "1", q(money(d.price)), "Delivered"].join(","));
}
writeFileSync(new URL("../data/sample-orders.csv", import.meta.url), rows.join("\n") + "\n");
console.log(`wrote ${rows.length - 1} rows`);

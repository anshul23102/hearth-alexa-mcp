// Generates the SYNTHETIC sample households (data/sample-orders.csv, sample-family.csv, sample-india.csv): a SYNTHETIC but deliberately messy order export.
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
const homeConsumables: Item[] = [
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
const homeDurables = [
  { title: "Ninja Foodi 6.5 Qt Pressure Cooker Steam Fryer OP302", daysAgo: 540, price: 15999 },
  { title: "Cuisinart Compact Blender & Juice Extractor Combo", daysAgo: 1100, price: 8999 },
  { title: "Dyson V8 Cordless Vacuum Cleaner", daysAgo: 400, price: 34999 },
  { title: "Philips Sonicare ProtectiveClean 4100 Rechargeable Toothbrush", daysAgo: 220, price: 6995 },
];

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

type Profile = {
  file: string; consumables: Item[]; durables: { title: string; daysAgo: number; price: number }[];
  formats: ((d: Date) => string)[]; money: (cents: number) => string;
};

const usMoney = (c: number) => (rnd() < 0.25 ? `USD ${(c / 100).toFixed(2)}` : rnd() < 0.5 ? `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : (c / 100).toFixed(2));
const usFormats = [
  (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`,
  (d: Date) => d.toISOString().slice(0, 10),
  (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
];
// India exports are day-first (13/02/2026) and priced in rupees.
const inMoney = (c: number) => (rnd() < 0.3 ? `Rs. ${(c / 100).toFixed(2)}` : `₹${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
const inFormats = [
  (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`,
  (d: Date) => `${d.getUTCDate()}-${d.getUTCMonth() + 1}-${d.getUTCFullYear()}`,
];

const profiles: Profile[] = [
  { file: "sample-orders.csv", consumables: homeConsumables, durables: homeDurables, formats: usFormats, money: usMoney },
  {
    // A household with a baby: real recalls exist for Philips Avent monitors (SCD630/SCD843), Fisher-Price and Anker power banks.
    file: "sample-family.csv", formats: usFormats, money: usMoney,
    consumables: [
      { titles: ["Pampers Swaddlers Newborn Diapers, 124 Count", "Pampers Swaddlers Diapers Size 1, 140 Count"], gap: 11, price: 4299 },
      { titles: ["Similac Pro-Advance Infant Formula Powder, 36 oz"], gap: 9, price: 4199 },
      { titles: ["Huggies Natural Care Sensitive Baby Wipes, 560 Count"], gap: 21, price: 1999 },
      { titles: ["Dreft Stage 1 Newborn Baby Laundry Detergent, 64 oz"], gap: 42, price: 1197 },
      { titles: ["Bounty Select-A-Size Paper Towels, 12 Triple Rolls"], gap: 23, price: 2699 },
      { titles: ["Cheerios Gluten Free Breakfast Cereal, Family Size 18 oz"], gap: 14, price: 599 },
    ],
    durables: [
      { title: "Philips Avent Digital Video Baby Monitor SCD843/37", daysAgo: 300, price: 17999 },
      { title: "Fisher-Price Brunch & Go Stroller Toys, Infant Stroller Activity Set", daysAgo: 140, price: 1999 },
      { title: "Anker Portable Charger Power Bank PowerCore 10000 A1263", daysAgo: 600, price: 2599 },
      { title: "Oster French Door Countertop Oven Toaster Oven", daysAgo: 420, price: 12999 },
    ],
  },
  {
    file: "sample-india.csv", formats: inFormats, money: inMoney,
    consumables: [
      { titles: ["Aashirvaad Select Premium Sharbati Atta, 10 kg"], gap: 26, price: 55900 },
      { titles: ["Fortune Sunlite Refined Sunflower Oil, 5 L Jar", "Fortune Sunlite Refined Sunflower Oil 5 Litre"], gap: 32, price: 78500 },
      { titles: ["Tata Salt Vacuum Evaporated Iodised Salt, 1 kg"], gap: 40, price: 2800 },
      { titles: ["Surf Excel Matic Top Load Liquid Detergent, 2 L"], gap: 36, price: 52900 },
      { titles: ["Colgate Strong Teeth Toothpaste, 600 g (Pack of 4)"], gap: 58, price: 29000 },
      { titles: ["Amul Taaza Toned Milk Powder, 1 kg"], gap: 19, price: 41500 },
    ],
    durables: [
      { title: "Anker PowerCore 10000 Power Bank A1263", daysAgo: 500, price: 199900 },
      { title: "Philips Air Fryer HD9200/90 4.1 L", daysAgo: 330, price: 649900 },
      { title: "Prestige Iris 750 W Mixer Grinder with 3 Jars", daysAgo: 900, price: 349900 },
    ],
  },
];

for (const prof of profiles) {
  const rows: string[] = ["Order ID,Order Date,Product Name,ASIN,Quantity,Unit Price,Order Status"];
  let n = 0;
  const oid = () => `114-${String(7000000 + ++n * 137).padStart(7, "0")}-${String(1000000 + n * 91).padStart(7, "0")}`;
  const asin = () => "B0" + Math.floor(rnd() * 1e8).toString(36).toUpperCase().padStart(8, "0").slice(0, 8);
  for (const it of prof.consumables) {
    let t = anchor - 24 * 30 * DAY * 1 - Math.floor(rnd() * it.gap) * DAY;
    const a = asin();
    while (t < anchor - 2 * DAY) {
      const d = new Date(t);
      const fmt = prof.formats[Math.floor(rnd() * prof.formats.length)];
      const qty = rnd() < 0.12 ? 2 : 1;
      const status = rnd() < 0.04 ? "Cancelled" : rnd() < 0.03 ? "Returned" : "Delivered";
      const line = [oid(), q(fmt(d)), q(it.titles[Math.floor(rnd() * it.titles.length)]), a, rnd() < 0.05 ? "" : String(qty), q(prof.money(jitter(it.price, 0.03))), status].join(",");
      rows.push(line);
      if (rnd() < 0.04) rows.push(line); // exact duplicate row
      t += jitter(it.gap * qty, 0.18) * DAY;
    }
  }
  for (const d of prof.durables) {
    rows.push([oid(), q(prof.formats[prof.formats.length > 1 ? 1 : 0](new Date(anchor - d.daysAgo * DAY))), q(d.title), asin(), "1", q(prof.money(d.price)), "Delivered"].join(","));
  }
  writeFileSync(new URL(`../data/${prof.file}`, import.meta.url), rows.join("\n") + "\n");
  console.log(`${prof.file}: wrote ${rows.length - 1} rows`);
}

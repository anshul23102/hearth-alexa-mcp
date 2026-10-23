// The SYNTHETIC sample households: a deliberately messy order export the way real ones arrive (mixed date formats, currency symbols,
// duplicate rows, cancelled and returned lines, missing quantities, one product retitled between purchases).
//
// Dates are relative to an anchor (today when served), so the demo looks the same whenever someone opens it: nothing is "overdue by
// three weeks" just because the file is old. Quantities, prices and cadences are chosen to be plausible for a real household (a pack
// of 90 toilet rolls does not run out in four weeks); test/data-sanity.test.ts checks that, from the generated numbers themselves.
// Appliances carry fixed purchase dates, because whether a recall applies depends on whether the unit was bought before it.

export const SAMPLE_FILES = ["sample-orders.csv", "sample-family.csv", "sample-india.csv"] as const;
export type SampleFile = (typeof SAMPLE_FILES)[number];

const DAY = 86_400_000;
type Item = { titles: string[]; gap: number; price: number };
type Durable = { title: string; bought: string; price: number };
interface Profile { consumables: Item[]; durables: Durable[]; style: "us" | "india" }

const PROFILES: Record<SampleFile, Profile> = {
  "sample-orders.csv": {
    style: "us",
    consumables: [
      { titles: ["Bounty Select-A-Size Paper Towels, 12 Triple Rolls", "BOUNTY Paper Towels Select a Size 12 Triple Rolls Family Pack"], gap: 30, price: 2699 },
      { titles: ["Charmin Ultra Soft Toilet Paper, 18 Mega Rolls", "Charmin Ultra Soft Toilet Paper 18 Mega Rolls = 90 Regular"], gap: 56, price: 2449 },
      { titles: ["Tide PODS Laundry Detergent Soap Pacs, 81 Count"], gap: 65, price: 2197 },
      { titles: ["Cascade Platinum Dishwasher Detergent Pods, 62 Count"], gap: 55, price: 1899 },
      { titles: ["Glad ForceFlex Tall Kitchen Trash Bags, 80 Count"], gap: 70, price: 1649 },
      { titles: ["Kirkland Signature Organic Dog Food Chicken 35 lb", "Kirkland Organic Dog Food Chicken, 35 Pound Bag"], gap: 36, price: 3299 },
      { titles: ["Nespresso Original Capsules Coffee Pods, 50 Count"], gap: 17, price: 3500 },
      { titles: ["Nature Made Vitamin D3 2000 IU, 220 Softgels"], gap: 110, price: 1399 },
      { titles: ["Colgate Total Toothpaste, 4 Pack"], gap: 62, price: 1599 },
    ],
    durables: [
      { title: "Ninja Foodi 6.5 Qt Pressure Cooker Steam Fryer OP302", bought: "2025-04-29", price: 15999 }, // two days before the real SharkNinja recall
      { title: "Cuisinart Compact Blender & Juice Extractor Combo", bought: "2023-10-17", price: 8999 },
      { title: "Dyson V8 Cordless Vacuum Cleaner", bought: "2025-09-14", price: 34999 },
      { title: "Philips Sonicare ProtectiveClean 4100 Rechargeable Toothbrush", bought: "2026-03-20", price: 6995 },
    ],
  },
  "sample-family.csv": {
    style: "us",
    // A household with a baby. Real recalls exist for Philips Avent monitors (SCD630, SCD843), Fisher-Price toys and Anker power banks.
    consumables: [
      { titles: ["Pampers Swaddlers Newborn Diapers, 124 Count", "Pampers Swaddlers Diapers Size 1, 140 Count"], gap: 11, price: 4299 },
      { titles: ["Similac Pro-Advance Infant Formula Powder, 36 oz"], gap: 10, price: 4199 },
      { titles: ["Huggies Natural Care Sensitive Baby Wipes, 560 Count"], gap: 45, price: 1999 },
      { titles: ["Dreft Stage 1 Newborn Baby Laundry Detergent, 64 oz"], gap: 42, price: 1197 },
      { titles: ["Bounty Select-A-Size Paper Towels, 12 Triple Rolls"], gap: 30, price: 2699 },
      { titles: ["Cheerios Gluten Free Breakfast Cereal, Family Size 18 oz"], gap: 14, price: 599 },
    ],
    durables: [
      { title: "Philips Avent Digital Video Baby Monitor SCD843/37", bought: "2023-06-12", price: 17999 }, // before the August 2023 recall
      { title: "Fisher-Price Brunch & Go Stroller Toys, Infant Stroller Activity Set", bought: "2025-02-08", price: 1999 },
      { title: "Anker Portable Charger Power Bank PowerCore 10000 A1263", bought: "2025-02-28", price: 2599 },
      { title: "Oster French Door Countertop Oven Toaster Oven", bought: "2025-08-27", price: 12999 },
    ],
  },
  "sample-india.csv": {
    style: "india",
    // Prices are in paise (rupees x 100).
    consumables: [
      { titles: ["Aashirvaad Select Premium Sharbati Atta, 10 kg"], gap: 26, price: 55900 },
      { titles: ["Fortune Sunlite Refined Sunflower Oil, 5 L Jar", "Fortune Sunlite Refined Sunflower Oil 5 Litre"], gap: 32, price: 78500 },
      { titles: ["Tata Salt Vacuum Evaporated Iodised Salt, 1 kg"], gap: 45, price: 2800 },
      { titles: ["Surf Excel Matic Top Load Liquid Detergent, 2 L"], gap: 36, price: 52900 },
      { titles: ["Colgate Strong Teeth Toothpaste, 600 g (Pack of 4)"], gap: 58, price: 29000 },
      { titles: ["Amul Taaza Toned Milk Powder, 1 kg"], gap: 30, price: 41500 },
    ],
    durables: [
      { title: "Anker PowerCore 10000 Power Bank A1263", bought: "2025-04-02", price: 199900 },
      { title: "Philips Air Fryer HD9200/90 4.1 L", bought: "2025-11-17", price: 649900 },
      { title: "Prestige Iris 750 W Mixer Grinder with 3 Jars", bought: "2024-01-19", price: 349900 },
    ],
  },
};

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** The CSV text for one sample household, with its dates counted back from `anchorISO` (yyyy-mm-dd). Deterministic for a given anchor. */
export function generateSample(file: SampleFile, anchorISO: string): string {
  const prof = PROFILES[file];
  const anchor = Date.parse(anchorISO);
  let seed = 20261021 + SAMPLE_FILES.indexOf(file) * 7919; // each household has its own stream, so adding one never changes another
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const jitter = (n: number, pct: number) => Math.round(n * (1 + (rnd() * 2 - 1) * pct));

  const usMoney = (c: number) => (rnd() < 0.25 ? `USD ${(c / 100).toFixed(2)}` : rnd() < 0.5 ? `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : (c / 100).toFixed(2));
  const inMoney = (c: number) => (rnd() < 0.3 ? `Rs. ${(c / 100).toFixed(2)}` : `₹${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
  const usFormats = [
    (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`,
    (d: Date) => d.toISOString().slice(0, 10),
    (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
  ];
  // India exports are day-first (13/02/2026).
  const inFormats = [
    (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`,
    (d: Date) => `${d.getUTCDate()}-${d.getUTCMonth() + 1}-${d.getUTCFullYear()}`,
  ];
  const money = prof.style === "india" ? inMoney : usMoney;
  const formats = prof.style === "india" ? inFormats : usFormats;

  const rows: string[] = ["Order ID,Order Date,Product Name,ASIN,Quantity,Unit Price,Order Status"];
  let n = 0;
  const oid = () => `114-${String(7000000 + ++n * 137).padStart(7, "0")}-${String(1000000 + n * 91).padStart(7, "0")}`;
  const asin = () => "B0" + Math.floor(rnd() * 1e8).toString(36).toUpperCase().padStart(8, "0").slice(0, 8);

  for (const it of prof.consumables) {
    let t = anchor - 24 * 30 * DAY + Math.floor(rnd() * it.gap) * DAY; // at most two years of history, starting a little after its beginning
    const a = asin();
    while (t < anchor - 2 * DAY) {
      const fmt = formats[Math.floor(rnd() * formats.length)];
      const qty = rnd() < 0.08 ? 2 : 1;
      const step = jitter(it.gap * qty, 0.18) * DAY;
      const last = t + step >= anchor - 2 * DAY; // the most recent order of each product was delivered, so the demo starts from a sensible place
      const status = last ? "Delivered" : rnd() < 0.04 ? "Cancelled" : rnd() < 0.03 ? "Returned" : "Delivered";
      const line = [oid(), q(fmt(new Date(t))), q(it.titles[Math.floor(rnd() * it.titles.length)]), a, rnd() < 0.03 ? "" : String(qty), q(money(jitter(it.price, 0.03))), status].join(",");
      rows.push(line);
      if (rnd() < 0.04) rows.push(line); // an exact duplicate row, as real exports have
      t += step; // two packs last twice as long
    }
  }
  for (const d of prof.durables) rows.push([oid(), q(formats[formats.length > 1 ? 1 : 0](new Date(Date.parse(d.bought)))), q(d.title), asin(), "1", q(money(d.price)), "Delivered"].join(","));
  return rows.join("\n") + "\n";
}

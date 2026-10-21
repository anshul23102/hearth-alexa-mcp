// Turning messy marketplace export rows into clean, comparable records.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Parse the date formats seen in real order exports. Returns ISO yyyy-mm-dd or null. */
export function parseDate(raw: string, dayFirstHint = false): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    if (a > 12) return iso(y, b, a);
    if (b > 12) return iso(y, a, b);
    return dayFirstHint ? iso(y, b, a) : iso(y, a, b);
  }
  m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].toLowerCase());
    return mi >= 0 ? iso(+m[3], mi + 1, +m[2]) : null;
  }
  m = s.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.? (\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[2].toLowerCase());
    return mi >= 0 ? iso(+m[3], mi + 1, +m[1]) : null;
  }
  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}

/** "$1,299.00", "USD 12.5", "₹499", "12,50 €" -> cents. */
export function parseMoneyCents(raw: string): number | null {
  let s = raw.replace(/[^\d.,-]/g, "");
  if (!s) return null;
  if (/,\d{2}$/.test(s) && !/\.\d{2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const NOISE = /\b(\d+\s*(count|ct|pack|pk|pcs|pieces|rolls?|oz|ounces?|fl|lb|lbs|ml|l|g|kg|sheets?|ply|bags?|loads?|wipes?)|pack of \d+|value pack|family size|bulk|\(.*?\))\b/gi;

/** Stable key for "the same thing" across title rewrites and pack sizes. */
export function productKey(title: string): string {
  const t = title
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(NOISE, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(\d+)\b/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  return t.slice(0, 5).join(" ");
}

const STOP = new Set(["the", "and", "for", "with", "of", "pack", "new", "free", "ct", "count"]);

/** Units contained in one purchased line ("12 Count" x qty 2 = 24 units). Falls back to 1. */
export function packUnits(title: string): number {
  const m =
    title.match(/pack of (\d+)/i) ??
    title.match(/(\d+)\s*(?:count|ct|pk|pack|rolls?|wipes?|pods?|bags?)\b/i);
  const n = m ? Number(m[1]) : 1;
  return n > 0 && n < 1000 ? n : 1;
}

const CONSUMABLE = [
  "paper towel", "toilet paper", "tissue", "detergent", "dish soap", "dishwasher", "trash bag", "coffee", "k cup",
  "pods", "diaper", "wipes", "shampoo", "conditioner", "toothpaste", "razor", "batteries", "filter", "cat litter",
  "dog food", "cat food", "vitamin", "protein", "olive oil", "oats", "rice", "sponge", "hand soap", "sunscreen",
  "contact lens", "floss", "baby formula", "softener",
];
const DURABLE = [
  "pressure cooker", "air fryer", "instant pot", "blender", "toaster", "kettle", "crib", "stroller", "high chair",
  "space heater", "heater", "vacuum", "humidifier", "dehumidifier", "fan", "lamp", "treadmill", "bike", "helmet",
  "car seat", "monitor", "charger", "power bank", "slow cooker", "rice cooker", "coffee maker", "mixer", "oven",
  "dryer", "dishwasher machine", "robot", "scooter", "ladder", "grill", "bed rail", "bassinet", "swing", "airfryer",
];

export type Kind = "consumable" | "durable" | "other";

export function classify(title: string): Kind {
  const t = title.toLowerCase();
  if (DURABLE.some((k) => t.includes(k)) && !/\bfilter\b|\bpod\b|\bliner\b/.test(t)) return "durable";
  if (CONSUMABLE.some((k) => t.includes(k))) return "consumable";
  return "other";
}

export function normalizeStatus(raw: string): "delivered" | "cancelled" | "returned" | "open" {
  const s = raw.toLowerCase();
  if (/cancel/.test(s)) return "cancelled";
  if (/return|refund/.test(s)) return "returned";
  if (/deliver|shipped|complete|closed/.test(s) || !s.trim()) return "delivered";
  return "open";
}

/** Two title keys describe the same product if their word sets overlap strongly (Jaccard >= 0.6). */
export function sameProduct(a: string, b: string): boolean {
  const A = new Set(a.split(" ")), B = new Set(b.split(" "));
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= 0.6;
}

/** "BOUNTY Paper Towels Select a Size 12 Triple Rolls" -> "Bounty paper towels": what a person would say aloud. */
export function friendlyName(title: string): string {
  const clean = title.replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  let brand = words[0] ?? "";
  if (brand.length > 1 && brand === brand.toUpperCase()) brand = brand[0] + brand.slice(1).toLowerCase();
  const lower = clean.toLowerCase();
  let best: { at: number; text: string } | null = null;
  for (const k of [...CONSUMABLE, ...DURABLE, "toothpaste", "toothbrush", "dog food", "blender", "vacuum"]) {
    const at = lower.indexOf(k);
    if (at > 0 && (!best || at < best.at)) best = { at, text: clean.slice(at, at + k.length + (lower[at + k.length] === "s" ? 1 : 0)).toLowerCase() };
  }
  if (best) return `${brand} ${best.text}`;
  return words.slice(0, 3).join(" ");
}

// ---- currency (global exports mix symbols, ISO codes and minor-unit conventions) ----------------------------

const SYMBOLS: [RegExp, string][] = [
  [/\bUSD\b|US\$/i, "USD"], [/\bCAD\b|CA\$|C\$/i, "CAD"], [/\bGBP\b|£/i, "GBP"], [/\bEUR\b|€/i, "EUR"],
  [/\bINR\b|₹|\bRs\.?/i, "INR"], [/\bJPY\b|¥|円/i, "JPY"], [/\bAUD\b|A\$/i, "AUD"], [/\bMXN\b/i, "MXN"],
  [/\bBRL\b|R\$/i, "BRL"], [/\bSGD\b|S\$/i, "SGD"], [/\bAED\b/i, "AED"], [/\bKRW\b|₩/i, "KRW"], [/\bCHF\b/i, "CHF"],
  [/\bSEK\b/i, "SEK"], [/\bPLN\b|zł/i, "PLN"],
  [/\$/, "USD"],
];
/** Currency code found in a price string or column, or null. A bare "$" is read as USD. */
export function parseCurrency(raw: string): string | null {
  for (const [re, code] of SYMBOLS) if (re.test(raw)) return code;
  const m = raw.trim().toUpperCase().match(/^[A-Z]{3}$/);
  return m ? m[0] : null;
}
export function minorDigits(currency: string): number {
  try { return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
}
/** Amount in the currency's minor unit (cents, pence, or whole yen). */
export function toMinor(raw: string, currency: string): number | null {
  const cents = parseMoneyCents(raw);
  if (cents === null) return null;
  const d = minorDigits(currency);
  return d === 2 ? cents : Math.round((cents / 100) * 10 ** d);
}

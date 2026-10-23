// Evaluates recall matching against REAL notices. Usage: npm run eval [-- db-path]
// Builds (or reuses) a local recall index first, so it works on a fresh clone with network access.
//
// Positives are built from real CPSC notices that name a product and list model numbers; negatives are the
// cases that cause false alarms in practice. This is optimistic for positives (titles come from the notice
// itself), so treat positive recall as an upper bound and the negative rates as the number to watch.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { matchOwned, brandOf, modelTokens } from "../src/recalls.js";
import { syncRecalls } from "../src/recallIndex.js";

const db = openDb(process.argv[2] ?? join(tmpdir(), "hearth-eval.db"));
const synced = await syncRecalls(db);
if (synced.some((s) => s.mode === "fixture")) console.warn("warning: a feed could not be reached; results below use the small bundled snapshot and are NOT comparable to the published numbers.\n");
const rows = db.prepare("SELECT ext_id, date, title, product, text FROM recalls WHERE source = 'cpsc' AND date >= '2012-01-01'").all() as unknown as { ext_id: string; date: string; title: string; product: string; text: string }[];

interface Case { title: string; last: string; recallId: string; kind: "pos" | "wrong-model" | "other-product" | "accessory" }
const cases: Case[] = [];

for (const r of rows) {
  const name = r.product.replace(/\s+/g, " ").trim();
  if (name.length < 8 || name.length > 120) continue;
  const brand = brandOf(name);
  if (brand.length < 3 || /^(the|all|about|various|multiple|certain)$/i.test(brand)) continue;
  const models = modelTokens(r.text).filter((m) => /[A-Z]/.test(m) && /\d/.test(m) && m.length >= 4 && m.length <= 12);
  if (!models.length) continue;
  const last = r.date > "2013-01-01" ? addDays(r.date, -200) : r.date; // owned before the recall
  cases.push({ title: `${name} ${models[0]}`, last, recallId: r.ext_id, kind: "pos" });
  // same brand and product type, but a model the notice does not list
  const wrong = models[0].replace(/\d/g, (d) => String((Number(d) + 3) % 10)) + "X";
  // (strip model tokens already inside the product name, e.g. "OP300 Series", so the wrong model is the only one)
  const bare = name.split(" ").filter((w) => modelTokens(w).length === 0).join(" ");
  if (!modelTokens(r.text).includes(wrong) && bare.length >= 8) cases.push({ title: `${bare} ${wrong}`, last, recallId: r.ext_id, kind: "wrong-model" });
  // same brand, unrelated product
  cases.push({ title: `${brand} Gift Card Holder Wallet`, last, recallId: r.ext_id, kind: "other-product" });
  // third-party replacement part for the brand's product
  cases.push({ title: `Replacement Battery for ${name}`, last, recallId: r.ext_id, kind: "accessory" });
}
function addDays(iso: string, d: number) { return new Date(Date.parse(iso) + d * 86_400_000).toISOString().slice(0, 10); }

const stat: Record<string, { n: number; any: number; likely: number; target: number }> = {};
for (const c of cases) {
  const ms = matchOwned(db, { title: c.title, last: c.last, productKey: "k" }, ["US"]);
  const s = (stat[c.kind] ??= { n: 0, any: 0, likely: 0, target: 0 });
  s.n++;
  if (ms.length) s.any++;
  if (ms.some((m) => m.level === "likely")) s.likely++;
  if (ms.some((m) => m.recall.number === c.recallId)) s.target++;
}
const pct = (a: number, n: number) => `${((100 * a) / n).toFixed(1)}%`;
console.log(`cases: ${cases.length} from ${rows.length} real CPSC notices\n`);
const P = stat.pos;
console.log(`POSITIVES (owned product is in a recall notice), n=${P.n}`);
console.log(`  surfaced the right recall at all:   ${pct(P.target, P.n)}`);
console.log(`  flagged as "likely" (confident):    ${pct(P.likely, P.n)}`);
for (const k of ["wrong-model", "other-product", "accessory"] as const) {
  const s = stat[k];
  console.log(`NEGATIVE ${k.padEnd(13)} n=${s.n}: any alert ${pct(s.any, s.n)}   false "likely" ${pct(s.likely, s.n)}`);
}

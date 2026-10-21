import type { DatabaseSync } from "node:sqlite";
import { audit } from "./db.js";
import { friendlyName } from "./normalize.js";
import { ensureRecallIndex, searchByBrand, type Region, type RecallRecord } from "./recallIndex.js";

export interface RecallMatch {
  owned: { title: string; name: string; lastPurchased: string; productKey: string };
  recall: {
    id: string; number: string; date: string; title: string; url: string; region: Region; source: string;
    hazard: string; hazardShort: string; remedy: string; image?: string;
  };
  level: "likely" | "possible";
  score: number;
  evidence: string[];
}

const STOP = new Set(["the", "and", "with", "for", "in", "electric", "multi", "function", "quart", "qt", "stainless", "steel", "black", "white", "pro", "plus", "max", "recalls", "recalled", "due", "hazard"]);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

/** "...Due to Serious Burn Hazard, Multiple..." -> "a burn hazard" (for speech). */
export function shortHazard(title: string): string {
  const m = title.match(/due to (?:the )?(?:risk of )?(?:serious |possible |potential )?([^,;]+?)(?:[,;]|$)/i);
  const h = (m?.[1] ?? "a safety hazard").toLowerCase().trim();
  return /^(a|an) /.test(h) ? h : h.endsWith("hazard") || h.endsWith("hazards") ? `a ${h.replace(/hazards$/, "hazard")}` : h;
}
export function brandOf(title: string): string {
  return (title.trim().split(/\s+/)[0] ?? "").replace(/[^A-Za-z0-9]/g, "");
}
/** Tokens that look like model numbers: letters followed by digits (OP302, KY-318B) or 4+ digit runs. */
export function modelTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b[A-Za-z]{1,5}-?\d{2,}[A-Za-z0-9-]*\b|\b\d{4,}\b/g)) out.add(m[0].toUpperCase().replace(/-/g, ""));
  return [...out];
}

export function scoreMatch(owned: { title: string; last: string }, brand: string, r: RecallRecord): { score: number; evidence: string[] } | null {
  const hay = `${r.title} ${r.product}`.toLowerCase();
  const evidence: string[] = [];
  let score = 0;
  if (!hay.includes(brand.toLowerCase())) return null;
  score += 2; evidence.push(`brand "${brand}" named in recall`);
  // "Replacement battery for Dyson V6" is about a third party's part, not the brand's own product.
  if (new RegExp(`\\b(for|fits|compatible with)\\s+(the\\s+)?${brand.toLowerCase()}`).test(hay) || /\breplacement\b/.test(hay)) { score -= 3; evidence.push("looks like an accessory or replacement part for this brand"); }
  const ownedWords = words(owned.title);
  const shared = ownedWords.filter((w) => w !== brand.toLowerCase() && hay.includes(w));
  if (shared.length >= 2) { score += 2; evidence.push(`same product type (${shared.slice(0, 3).join(", ")})`); }
  else if (shared.length === 0) return null;
  const ownedModels = modelTokens(owned.title);
  const recallModels = modelTokens(r.text);
  const text = r.text.toUpperCase().replace(/-/g, "");
  const hit = ownedModels.filter((m) => text.includes(m) || recallModels.some((rm) => rm.startsWith(m.slice(0, 5)) && m.slice(0, 5).length >= 4));
  if (hit.length) { score += 3; evidence.push(`model ${hit[0]} matches recalled model range`); }
  else if (ownedModels.length && recallModels.length) { score -= 1; evidence.push("model number not listed in recall — verify the label"); }
  if (r.date < owned.last) { score -= 1; evidence.push("bought after recall date — may be a corrected unit"); }
  return score >= 3 ? { score, evidence } : null;
}

/** Match one owned product against the index. Exported so the evaluation harness exercises the exact production path. */
export function matchOwned(db: DatabaseSync, item: { title: string; last: string; productKey: string }, regions: Region[]): RecallMatch[] {
  const brand = brandOf(item.title);
  if (brand.length < 3) return [];
  const perItem: RecallMatch[] = [];
  for (const r of searchByBrand(db, brand, regions)) {
    const s = scoreMatch({ title: item.title, last: item.last }, brand, r);
    if (!s) continue;
    perItem.push({
      owned: { title: item.title, name: friendlyName(item.title), lastPurchased: item.last, productKey: item.productKey },
      recall: { id: `${r.source}:${r.extId}`, number: r.extId, date: r.date, title: r.title, url: r.url, region: r.region, source: r.source, hazard: r.hazard, hazardShort: shortHazard(r.title), remedy: r.remedy, image: r.image },
      level: s.score >= 6 ? "likely" : "possible", score: s.score, evidence: s.evidence,
    });
  }
  perItem.sort((a, b) => b.score - a.score || (a.recall.date < b.recall.date ? 1 : -1));
  return perItem.slice(0, 3);
}

export async function checkRecalls(
  db: DatabaseSync, household: string, now = Date.now(), regions: Region[] = ["US", "CA"],
): Promise<{ matches: RecallMatch[]; checked: number; regions: Region[]; indexed: number }> {
  await ensureRecallIndex(db);
  const owned = db
    .prepare(
      `SELECT product_key, MAX(title) AS title, MAX(ordered_at) AS last FROM orders
       WHERE household = ? AND kind = 'durable' AND status != 'returned' GROUP BY product_key`,
    )
    .all(household) as unknown as { product_key: string; title: string; last: string }[];

  const matches: RecallMatch[] = [];
  for (const item of owned) matches.push(...matchOwned(db, { title: item.title, last: item.last, productKey: item.product_key }, regions));
  matches.sort((a, b) => b.score - a.score);
  const indexed = (db.prepare("SELECT COUNT(*) AS n FROM recalls").get() as { n: number }).n;
  audit(db, household, "check_recalls", { checked: owned.length, matches: matches.length, regions, indexed }, now);
  return { matches, checked: owned.length, regions, indexed };
}

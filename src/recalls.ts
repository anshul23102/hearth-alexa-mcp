import type { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { audit } from "./db.js";

const API = "https://www.saferproducts.gov/RestWebServices/Recall";
const TTL_MS = 24 * 3600_000;
const FIXTURE = new URL("../data/recalls-fixture.json", import.meta.url);

export interface CpscRecall {
  RecallID: number;
  RecallNumber: string;
  RecallDate: string;
  Title: string;
  Description: string;
  URL: string;
  Products: { Name: string; Model?: string }[];
  Hazards?: { Name: string }[];
  Remedies?: { Name: string }[];
  Images?: { URL: string; Caption: string }[];
}

export interface RecallMatch {
  owned: { title: string; lastPurchased: string; productKey: string };
  recall: {
    id: number; number: string; date: string; title: string; url: string;
    hazard: string; remedy: string; image?: string;
  };
  level: "likely" | "possible";
  score: number;
  evidence: string[];
  source: "live" | "cache" | "fixture";
}

const STOP = new Set(["the", "and", "with", "for", "in", "electric", "multi", "function", "quart", "qt", "stainless", "steel", "black", "white", "pro", "plus", "max"]);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

export function brandOf(title: string): string {
  return (title.trim().split(/\s+/)[0] ?? "").replace(/[^A-Za-z0-9]/g, "");
}
/** Tokens that look like model numbers: mixed letters+digits or 4+ digit runs. */
export function modelTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b[A-Za-z]{0,5}\d{2,}[A-Za-z0-9-]*\b/g)) out.add(m[0].toUpperCase().replace(/-/g, ""));
  return [...out];
}

async function fetchBrand(db: DatabaseSync, brand: string, now: number): Promise<{ rows: CpscRecall[]; source: RecallMatch["source"] }> {
  const q = brand.toLowerCase();
  const cached = db.prepare("SELECT fetched_at, body FROM recall_cache WHERE query = ?").get(q) as { fetched_at: number; body: string } | undefined;
  if (cached && now - cached.fetched_at < TTL_MS) return { rows: JSON.parse(cached.body), source: "cache" };
  try {
    const res = await fetch(`${API}?format=json&RecallDateStart=2018-01-01&ProductName=${encodeURIComponent(brand)}`, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`CPSC ${res.status}`);
    const rows = (await res.json()) as CpscRecall[];
    db.prepare("INSERT OR REPLACE INTO recall_cache (query, fetched_at, body) VALUES (?, ?, ?)").run(q, now, JSON.stringify(rows));
    return { rows, source: "live" };
  } catch {
    if (cached) return { rows: JSON.parse(cached.body), source: "cache" };
    if (existsSync(FIXTURE)) {
      const all = JSON.parse(readFileSync(FIXTURE, "utf8")) as CpscRecall[];
      return { rows: all.filter((r) => `${r.Title} ${r.Products.map((p) => p.Name).join(" ")}`.toLowerCase().includes(q)), source: "fixture" };
    }
    return { rows: [], source: "fixture" };
  }
}

export async function checkRecalls(db: DatabaseSync, household: string, now = Date.now()): Promise<{ matches: RecallMatch[]; checked: number; sources: string[] }> {
  const owned = db
    .prepare(
      `SELECT product_key, MAX(title) AS title, MAX(ordered_at) AS last FROM orders
       WHERE household = ? AND kind = 'durable' AND status != 'returned' GROUP BY product_key`,
    )
    .all(household) as unknown as { product_key: string; title: string; last: string }[];

  const matches: RecallMatch[] = [];
  const sources = new Set<string>();
  for (const item of owned) {
    const brand = brandOf(item.title);
    if (brand.length < 3) continue;
    const { rows, source } = await fetchBrand(db, brand, now);
    sources.add(source);
    const ownedWords = words(item.title);
    const ownedModels = modelTokens(item.title);
    for (const r of rows) {
      const hay = `${r.Title} ${r.Products.map((p) => `${p.Name} ${p.Model ?? ""}`).join(" ")}`.toLowerCase();
      const desc = `${r.Description ?? ""}`.toUpperCase().replace(/-/g, "");
      const evidence: string[] = [];
      let score = 0;
      if (hay.includes(brand.toLowerCase())) { score += 2; evidence.push(`brand "${brand}" named in recall`); }
      else continue;
      const shared = ownedWords.filter((w) => w !== brand.toLowerCase() && hay.includes(w));
      if (shared.length >= 2) { score += 2; evidence.push(`same product type (${shared.slice(0, 3).join(", ")})`); }
      else if (shared.length === 0) continue;
      const recallModels = modelTokens(`${r.Title} ${r.Products.map((p) => `${p.Name} ${p.Model ?? ""}`).join(" ")} ${r.Description ?? ""}`);
      const hit = ownedModels.filter((m) => desc.includes(m) || recallModels.some((rm) => rm.startsWith(m.slice(0, 5)) && m.slice(0, 5).length >= 4));
      if (hit.length) { score += 3; evidence.push(`model ${hit[0]} matches recalled model range`); }
      else if (ownedModels.length && recallModels.length) { score -= 1; evidence.push("model number not listed in recall — verify the label"); }
      if (r.RecallDate.slice(0, 10) < item.last) { score -= 1; evidence.push("bought after recall date — may be a corrected unit"); }
      if (score < 3) continue;
      matches.push({
        owned: { title: item.title, lastPurchased: item.last, productKey: item.product_key },
        recall: {
          id: r.RecallID, number: r.RecallNumber, date: r.RecallDate.slice(0, 10), title: r.Title, url: r.URL,
          hazard: r.Hazards?.[0]?.Name ?? "See recall notice", remedy: r.Remedies?.[0]?.Name ?? "See recall notice",
          image: r.Images?.[0]?.URL,
        },
        level: score >= 6 ? "likely" : "possible",
        score, evidence, source,
      });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  audit(db, household, "check_recalls", { checked: owned.length, matches: matches.length, sources: [...sources] }, now);
  return { matches, checked: owned.length, sources: [...sources] };
}

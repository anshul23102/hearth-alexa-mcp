import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";

// A local, region-aware recall index. Instead of calling a regulator per question, Hearth syncs the
// full public feeds (U.S. CPSC ~5.3k recalls, Health Canada consumer products ~5.2k) into SQLite once and
// answers every household from that index. Adding a region means adding a Provider.

export type Region = "US" | "CA";
export interface RecallRecord {
  source: string; extId: string; region: Region; date: string; title: string; product: string;
  /** Free text searched for model numbers. */
  text: string; url: string; hazard: string; remedy: string; image?: string;
}
export interface Provider {
  source: string;
  region: Region;
  fetchLive(fetchFn: typeof fetch): Promise<RecallRecord[]>;
  fromFixture(): RecallRecord[];
}

const FIXTURES = (name: string) => new URL(`../data/${name}`, import.meta.url);
const readFixture = (name: string): unknown[] => (existsSync(FIXTURES(name)) ? JSON.parse(readFileSync(FIXTURES(name), "utf8")) : []);
const clip = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

interface CpscRaw {
  RecallID: number; RecallNumber: string; RecallDate: string; Title: string; Description?: string; URL: string;
  Products?: { Name: string; Model?: string }[]; Hazards?: { Name: string }[]; Remedies?: { Name: string }[]; Images?: { URL: string }[];
}
export function mapCpsc(r: CpscRaw): RecallRecord {
  const product = (r.Products ?? []).map((p) => `${p.Name} ${p.Model ?? ""}`).join(" ");
  return {
    source: "cpsc", extId: String(r.RecallID), region: "US", date: String(r.RecallDate).slice(0, 10),
    title: clip(r.Title, 300), product: clip(product, 300), text: clip(`${r.Title} ${product} ${r.Description ?? ""}`, 4000),
    url: safeUrl(r.URL), hazard: clip(r.Hazards?.[0]?.Name ?? shortIssue(r.Title), 200), remedy: clip(r.Remedies?.[0]?.Name ?? "See the recall notice", 200),
    image: r.Images?.[0]?.URL,
  };
}
/** Only https links to the regulators we index ever reach the UI. */
const safeUrl = (u: string) => (/^https:\/\/((www\.)?cpsc\.gov|recalls-rappels\.canada\.ca)\//.test(String(u)) ? String(u) : "");
const shortIssue = (title: string) => (title.match(/due to (.*?)(?:[;,]|$)/i)?.[1] ?? "See the recall notice");

interface HcRaw { NID: string; Title: string | null; URL: string; Organization: string; Product: string | null; Issue: string | null; "What you should do": string | null; "Last updated": string }
export function mapHealthCanada(r: HcRaw): RecallRecord {
  return {
    source: "healthcanada", extId: String(r.NID), region: "CA", date: clip(r["Last updated"], 10),
    title: clip(r.Title, 300), product: clip(r.Product, 300), text: clip(`${r.Title ?? ""} ${r.Product ?? ""}`, 1500),
    url: safeUrl(r.URL), hazard: clip(r.Issue ?? "See the recall notice", 200),
    remedy: clip((r["What you should do"] ?? "").split(/(?<=\.)\s/)[0] || "See the recall notice", 220),
  };
}

/** GET with a per-attempt timeout and bounded retries; large public feeds hiccup, one slow response must not sink a sync. */
async function getJson<T>(f: typeof fetch, url: string, attempts = 3, timeoutMs = 45_000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await f(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) { last = e; if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i)); }
  }
  throw last instanceof Error ? last : new Error("fetch failed");
}

const cpscProvider: Provider = {
  source: "cpsc", region: "US",
  async fetchLive(f) {
    // One request: measured against the live API, date-windowed queries are 10x slower in total than the single pull
    // (about 20 s each for nine windows versus 2 to 16 s for everything), so retries are the right tool, not chunking.
    const rows = await getJson<CpscRaw[]>(f, "https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=2010-01-01", 3, 90_000);
    return rows.map(mapCpsc);
  },
  fromFixture: () => (readFixture("recalls-fixture.json") as CpscRaw[]).map(mapCpsc),
};

const healthCanadaProvider: Provider = {
  source: "healthcanada", region: "CA",
  async fetchLive(f) {
    const rows = await getJson<HcRaw[]>(f, "https://recalls-rappels.canada.ca/sites/default/files/opendata-donneesouvertes/HCRSAMOpenData.json", 3, 60_000);
    return rows.filter((r) => r.Organization === "Consumer product safety" && r.Title).map(mapHealthCanada);
  },
  fromFixture: () => (readFixture("recalls-hc-fixture.json") as HcRaw[]).filter((r) => r.Title).map(mapHealthCanada),
};

const DEFAULT_PROVIDERS: Provider[] = [cpscProvider, healthCanadaProvider];
const DAY = 86_400_000;
/** A feed that last failed or fell back to the bundled snapshot is retried soon; only a live download is trusted for a day. */
const RETRY_MS = 10 * 60_000;

export interface SyncResult { source: string; count: number; mode: "live" | "fixture" | "fresh" | "failed"; error?: string; /** Notices that were not in the index before this sync (empty on the very first sync). */ fresh: RecallRecord[] }

export async function syncRecalls(
  db: DatabaseSync,
  opts: { providers?: Provider[]; fetchFn?: typeof fetch; now?: number; force?: boolean; offline?: boolean } = {},
): Promise<SyncResult[]> {
  const { providers = DEFAULT_PROVIDERS, fetchFn = fetch, now = Date.now(), force = false } = opts;
  const offline = opts.offline ?? process.env.HEARTH_RECALLS_OFFLINE === "1";
  const results: SyncResult[] = [];
  for (const p of providers) {
    const last = db.prepare("SELECT synced_at, count, mode FROM recall_sync WHERE source = ?").get(p.source) as { synced_at: number; count: number; mode: string } | undefined;
    if (last && !force && now - last.synced_at < (last.mode === "live" ? DAY : RETRY_MS)) { results.push({ source: p.source, count: last.count, mode: "fresh", fresh: [] }); continue; }
    let records: RecallRecord[]; let mode: "live" | "fixture" = "live"; let error: string | undefined;
    try {
      if (offline) throw new Error("offline mode");
      records = await p.fetchLive(fetchFn);
      if (records.length === 0) throw new Error("empty feed");
    } catch (e) {
      error = (e as Error).message; mode = "fixture"; records = p.fromFixture();
    }
    if (mode === "fixture" && last && last.mode === "live" && last.count > records.length) {
      // Never replace a good live index with a smaller fixture because of a transient outage.
      results.push({ source: p.source, count: last.count, mode: "failed", error, fresh: [] });
      continue;
    }
    const fresh = storeRecalls(db, p.source, records);
    db.prepare("INSERT OR REPLACE INTO recall_sync (source, synced_at, count, mode) VALUES (?, ?, ?, ?)").run(p.source, now, records.length, mode);
    results.push({ source: p.source, count: records.length, mode, error, fresh });
  }
  return results;
}

/** Replace a source's notices atomically; returns the ones that are new (nothing is "new" on an empty index). */
export function storeRecalls(db: DatabaseSync, source: string, records: RecallRecord[]): RecallRecord[] {
  brandCache.clear();
  const before = new Set((db.prepare("SELECT ext_id FROM recalls WHERE source = ?").all(source) as unknown as { ext_id: string }[]).map((r) => r.ext_id));
  const ins = db.prepare(
    "INSERT OR REPLACE INTO recalls (source, ext_id, region, date, title, product, text, url, hazard, remedy, image, search) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM recalls WHERE source = ?").run(source);
    for (const r of records) {
      ins.run(r.source, r.extId, r.region, r.date, r.title, r.product, r.text, r.url, r.hazard, r.remedy, r.image ?? null, `${r.title} ${r.product}`.toLowerCase());
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return before.size === 0 ? [] : records.filter((r) => !before.has(r.extId));
}

export function recallStats(db: DatabaseSync) {
  return db.prepare("SELECT source, region, COUNT(*) AS n, MAX(date) AS newest FROM recalls GROUP BY source, region").all() as unknown as { source: string; region: Region; n: number; newest: string }[];
}

// Brands repeat across households, so cache brand lookups; any sync clears it.
const brandCache = new Map<string, RecallRecord[]>();
const BRAND_CACHE_MAX = 5000;

export function searchByBrand(db: DatabaseSync, brand: string, regions: Region[]): RecallRecord[] {
  const b = brand.toLowerCase();
  if (b.length < 3) return [];
  const ck = `${b}|${regions.join(",")}`;
  const hit = brandCache.get(ck);
  if (hit) return hit;
  const found = searchUncached(db, b, regions);
  if (brandCache.size >= BRAND_CACHE_MAX) brandCache.clear();
  brandCache.set(ck, found);
  return found;
}

function searchUncached(db: DatabaseSync, b: string, regions: Region[]): RecallRecord[] {
  const rows = db
    .prepare(`SELECT * FROM recalls WHERE instr(search, ?) > 0 AND region IN (${regions.map(() => "?").join(",")}) ORDER BY date DESC LIMIT 200`)
    .all(b, ...regions) as unknown as Record<string, string>[];
  return rows.map((r) => ({ source: r.source, extId: r.ext_id, region: r.region as Region, date: r.date, title: r.title, product: r.product, text: r.text, url: r.url, hazard: r.hazard, remedy: r.remedy, image: r.image || undefined }));
}

let inflight: Promise<unknown> | null = null;
/** Make sure the index has data before answering; concurrent callers share one sync. */
export async function ensureRecallIndex(db: DatabaseSync): Promise<void> {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM recalls").get() as { n: number }).n;
  if (n > 0) return;
  inflight ??= syncRecalls(db).finally(() => { inflight = null; });
  await inflight;
}

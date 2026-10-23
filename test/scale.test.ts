import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { openDb } from "../src/db.js";
import { CsvStream, parseCsv } from "../src/csv.js";
import { ingestOrders, ingestStream } from "../src/ingest.js";
import { parseCurrency, toMinor } from "../src/normalize.js";
import { fmtMoney } from "../src/money.js";
import { t, isLang, LANGS } from "../src/i18n.js";
import { syncRecalls, searchByBrand, mapCpsc, mapHealthCanada, type Provider, type RecallRecord } from "../src/recallIndex.js";
import { scoreMatch } from "../src/recalls.js";
import { forecast } from "../src/forecast.js";
import { propose } from "../src/actions.js";

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

test("CsvStream gives the same rows as parseCsv for any chunking", () => {
  const text = '﻿a,b,c\r\n"x, y","say ""hi""",3\n\n"multi\nline",,z\r\n1,2,3';
  const want = parseCsv(text);
  for (let size = 1; size <= 9; size++) {
    const s = new CsvStream();
    const got: string[][] = [];
    for (let i = 0; i < text.length; i += size) got.push(...s.push(text.slice(i, i + size)));
    got.push(...s.end());
    assert.deepEqual(got, want, `chunk size ${size}`);
  }
});

test("CsvStream caps a hostile field instead of exhausting memory", () => {
  const s = new CsvStream();
  const rows = [...s.push("a,b\n"), ...s.push("x," + "y".repeat(200_000) + "\n"), ...s.end()];
  assert.equal(rows[1][1].length, 64 * 1024);
  assert.equal(s.truncatedFields, 1);
});

test("importer survives junk, binary noise and hostile values without throwing", () => {
  const db = openDb(":memory:");
  const header = "Order ID,Order Date,Product Name,ASIN,Quantity,Unit Price,Order Status\n";
  const junk = (): string => {
    const pick = (xs: string[]) => xs[Math.floor(rnd() * xs.length)];
    return [
      pick(["", "114-1", "'; DROP TABLE orders;--", "\u0000\u0001", "x".repeat(500)]),
      pick(["", "2025-01-05", "13/13/2025", "Feb 30, 2025", "yesterday", "05.03.2025", "2025-02-29"]),
      pick(["", "Tide PODS 81 Count", "‮<script>alert(1)</script>", "  ", "Bounty Paper Towels", "💥".repeat(400)]),
      pick(["", "B000ABCDEF", "short", "😀"]),
      pick(["", "0", "-3", "99999999", "NaN", "2"]),
      pick(["", "$-5", "USD 12.5", "₹499", "1e308", "¥1,299", "free"]),
      pick(["Delivered", "Cancelled", "Returned", "???", ""]),
    ].map((c) => `"${c.replace(/"/g, '""')}"`).join(",");
  };
  const csv = header + Array.from({ length: 3000 }, junk).join("\n");
  const r = ingestOrders(db, "h", csv);
  assert.equal(r.rowsRead, 3000);
  assert.equal(r.imported + r.duplicates + r.skippedCount, 3000);
  assert.ok(r.skipped.length <= 50 && r.repaired.length <= 50, "report samples are bounded");
  const orders = db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number };
  assert.equal(orders.n, r.imported);
  forecast(db, "h"); // must not throw on whatever got in
});

test("streaming import matches the in-memory import and honors limits", async () => {
  const rows = ["Order ID,Order Date,Product Name,ASIN,Quantity,Unit Price,Order Status"];
  for (let i = 0; i < 6000; i++) rows.push(`o${i},2025-01-${String((i % 27) + 1).padStart(2, "0")},"Item ${i % 40} 12 Count",B0${String(1000000 + (i % 40))},1,$4.50,Delivered`);
  const csv = rows.join("\n");
  const a = openDb(":memory:"), b = openDb(":memory:");
  const ra = ingestOrders(a, "h", csv);
  const chunks = Array.from({ length: Math.ceil(csv.length / 977) }, (_, i) => Buffer.from(csv.slice(i * 977, (i + 1) * 977)));
  const rb = await ingestStream(b, "h", Readable.from(chunks));
  assert.equal(rb.imported, ra.imported);
  assert.equal(rb.duplicates, ra.duplicates);
  const capped = await ingestStream(openDb(":memory:"), "h", Readable.from(chunks), { maxRows: 100 });
  assert.equal(capped.truncated, true);
  assert.ok(capped.imported <= 100);
});

test("currencies are detected and held in the right minor unit", () => {
  assert.equal(parseCurrency("₹499"), "INR");
  assert.equal(parseCurrency("USD 12.5"), "USD");
  assert.equal(parseCurrency("£3.20"), "GBP");
  assert.equal(parseCurrency("12,50 €"), "EUR");
  assert.equal(parseCurrency("$9"), "USD");
  assert.equal(parseCurrency("nothing"), null);
  assert.equal(toMinor("¥1,299", "JPY"), 1299);
  assert.equal(toMinor("£3.20", "GBP"), 320);
  assert.match(fmtMoney(1299, "JPY", "ja"), /1,299/);
  assert.match(fmtMoney(49900, "INR", "hi-IN"), /₹/);
});

test("every language has every string with matching placeholders", () => {
  for (const l of Object.keys(LANGS)) assert.ok(isLang(l));
  const probe = { n: 1, due: 1, days: 1, list: "x", name: "x", d: 1, imported: 1, dups: 1, skipped: 1, repaired: 1, k: 1, regions: "US", hazard: "h", m: 1, matches: "m", total: "T", budget: "B", dropped: "D", prefix: "P", ref: "R", amount: "A", lang: "L" };
  const keys = ["import", "runway.none", "runway.clear", "runway.some", "runway.overdue", "runway.today", "runway.in", "recall.none", "recall.heads", "recall.found", "plan.empty", "plan.some", "plan.budget", "plan.dropped", "confirm.done", "confirm.needcode", "confirm.declined", "pref.budget", "pref.skip", "pref.lang", "pref.regions"] as const;
  for (const l of ["en", "es", "hi"] as const) for (const k of keys) {
    const out = t(l, k, probe);
    assert.ok(out.length > 0 && !/\{\w+\}/.test(out), `${l}.${k} leaves a placeholder: ${out}`);
  }
  assert.match(t("es", "runway.today", { name: "Café" }), /Café/);
});

const fake = (source: string, region: "US" | "CA", recs: RecallRecord[], fail = false): Provider => ({
  source, region,
  async fetchLive() { if (fail) throw new Error("boom"); return recs; },
  fromFixture: () => recs.slice(0, 1),
});
const rec = (id: string, title: string, region: "US" | "CA" = "US", text = title): RecallRecord => ({ source: "x", extId: id, region, date: "2025-05-01", title, product: "", text, url: "https://www.cpsc.gov/x", hazard: "Burn hazard", remedy: "Stop using" });

test("recall sync is atomic, idempotent, falls back to fixtures, and never shrinks a good index", async () => {
  const db = openDb(":memory:");
  const good = [rec("1", "Acme Kettle recalled"), rec("2", "Acme Toaster recalled"), rec("3", "Beta Fan recalled")];
  let r = await syncRecalls(db, { providers: [fake("x", "US", good)], offline: false });
  assert.deepEqual([r[0].mode, r[0].count], ["live", 3]);
  r = await syncRecalls(db, { providers: [fake("x", "US", good)], offline: false, now: Date.now() + 1000 });
  assert.equal(r[0].mode, "fresh", "second sync within 24h is a no-op");
  r = await syncRecalls(db, { providers: [fake("x", "US", good, true)], offline: false, force: true });
  assert.equal(r[0].mode, "failed", "a failing feed must not replace 3 live rows with 1 fixture row");
  assert.equal(searchByBrand(db, "acme", ["US"]).length, 2);
  const db2 = openDb(":memory:");
  const r2 = await syncRecalls(db2, { providers: [fake("x", "US", good, true)], offline: false });
  assert.equal(r2[0].mode, "fixture");
  assert.equal(searchByBrand(db2, "acme", ["US"]).length, 1);
});

test("feeds map to the common record shape", () => {
  const c = mapCpsc({ RecallID: 7, RecallNumber: "1", RecallDate: "2025-05-01T00:00:00", Title: "SharkNinja Recalls X Due to Burn Hazard; foo", Description: "models OP300", URL: "u", Products: [{ Name: "Foodi" }] });
  assert.deepEqual([c.region, c.hazard, c.date], ["US", "Burn Hazard", "2025-05-01"]);
  const h = mapHealthCanada({ NID: "9", Title: "Ninja X recalled", URL: "u", Organization: "Consumer product safety", Product: null, Issue: "Burn hazard", "What you should do": "Stop using it. Contact the firm.", "Last updated": "2025-05-01" });
  assert.deepEqual([h.region, h.remedy], ["CA", "Stop using it."]);
});

test("accessory and replacement-part recalls do not match the brand's own product", () => {
  const owned = { title: "Dyson V8 Cordless Vacuum Cleaner", last: "2025-01-01" };
  const part = rec("a", "FirstPower Battery Replacement for Dyson V6 Series Vacuums recalled due to fire hazard", "CA");
  assert.equal(scoreMatch(owned, "Dyson", part), null);
  const own = rec("b", "Dyson recalls V8 Cordless Vacuum Cleaners due to fire hazard", "US");
  assert.ok(scoreMatch(owned, "Dyson", own));
});

test("proposals never mix currencies", () => {
  const db = openDb(":memory:");
  const base = { unitsPerDay: 1, lastPurchase: "2025-01-01", lastUnits: 1, packUnits: 1, unitPriceCents: 1000, runoutDate: "2025-01-02", daysLeft: 1, windowDays: 1, confidence: "high" as const, status: "this_week" as const, purchases: 5 };
  const p = propose(db, "h", [
    { ...base, productKey: "a", title: "A", name: "A", currency: "INR" },
    { ...base, productKey: "b", title: "B", name: "B", currency: "USD" },
  ], { withinDays: 7, currency: "INR" });
  assert.equal(p.lines.length, 1);
  assert.equal(p.currency, "INR");
  assert.match(p.dropped[0].why, /priced in USD/);
});

test("a flaky feed is retried before the sync gives up", async () => {
  const db = openDb(":memory:");
  let cpscCalls = 0, failures = 2; // fails twice, then succeeds: inside the retry budget of three attempts
  const rows = Array.from({ length: 5 }, (_, i) => ({ RecallID: i + 1, RecallNumber: String(i), RecallDate: "2025-01-01T00:00:00", Title: `Acme Recalls Widget ${i} Due to Burn Hazard`, URL: "https://www.cpsc.gov/x", Products: [{ Name: "Acme Widget" }] }));
  const fakeFetch = (async (url: string) => {
    if (!new URL(String(url)).hostname.endsWith("saferproducts.gov")) return new Response("[]", { status: 200 }); // Health Canada: empty feed, falls back to its snapshot
    cpscCalls++;
    if (failures-- > 0) throw new Error("socket hang up");
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await syncRecalls(db, { fetchFn: fakeFetch, offline: false });
  const cpsc = r.find((x) => x.source === "cpsc")!;
  assert.equal(cpsc.mode, "live", `retries should have rescued the sync (${cpsc.error ?? ""})`);
  assert.equal(cpscCalls, 3, "two failed attempts, then the successful one");
  assert.equal(cpsc.count, 5);
});

test("a feed that keeps failing leaves the existing index untouched", async () => {
  const db = openDb(":memory:");
  const good = (async (url: string) => new Response(JSON.stringify(new URL(String(url)).hostname.endsWith("saferproducts.gov") ? Array.from({ length: 30 }, (_, i) => ({ RecallID: i + 1, RecallNumber: String(i), RecallDate: "2025-01-01T00:00:00", Title: `Acme Recalls Widget ${i} Due to Burn Hazard`, URL: "https://www.cpsc.gov/x", Products: [{ Name: "Acme Widget" }] })) : []), { status: 200 })) as unknown as typeof fetch;
  await syncRecalls(db, { fetchFn: good, offline: false });
  const before = searchByBrand(db, "acme", ["US"]).length;
  assert.ok(before > 0);
  const down = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  const r = await syncRecalls(db, { fetchFn: down, offline: false, force: true });
  assert.equal(r.find((x) => x.source === "cpsc")!.mode, "failed");
  assert.equal(searchByBrand(db, "acme", ["US"]).length, before, "outage must not shrink the index");
});

test("an outage fallback is retried within minutes and upgraded to live data, not trusted for a day", async () => {
  const db = openDb(":memory:");
  const t0 = Date.parse("2026-10-21T10:00:00Z");
  const rows = Array.from({ length: 40 }, (_, i) => ({ RecallID: i + 1, RecallNumber: String(i), RecallDate: "2025-01-01T00:00:00", Title: `Acme Recalls Widget ${i} Due to Burn Hazard`, URL: "https://www.cpsc.gov/x", Products: [{ Name: "Acme Widget" }] }));
  let up = false;
  const feed = (async (url: string) => {
    if (!up) throw new Error("network down");
    return new Response(new URL(String(url)).hostname.endsWith("saferproducts.gov") ? JSON.stringify(rows) : "[]", { status: 200 });
  }) as unknown as typeof fetch;
  const first = await syncRecalls(db, { fetchFn: feed, offline: false, now: t0 });
  assert.equal(first.find((x) => x.source === "cpsc")!.mode, "fixture", "outage: snapshot used");
  const soon = await syncRecalls(db, { fetchFn: feed, offline: false, now: t0 + 5 * 60_000 });
  assert.equal(soon.find((x) => x.source === "cpsc")!.mode, "fresh", "inside the retry window nothing is hammered");
  up = true;
  const later = await syncRecalls(db, { fetchFn: feed, offline: false, now: t0 + 11 * 60_000 });
  assert.equal(later.find((x) => x.source === "cpsc")!.mode, "live", "after 10 minutes the live feed replaces the snapshot");
  assert.equal(later.find((x) => x.source === "cpsc")!.count, 40);
  const next = await syncRecalls(db, { fetchFn: feed, offline: false, now: t0 + 12 * 60_000 });
  assert.equal(next.find((x) => x.source === "cpsc")!.mode, "fresh", "a live index is then trusted for a day");
});

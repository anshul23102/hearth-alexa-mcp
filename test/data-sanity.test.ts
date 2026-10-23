import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { ingestOrders } from "../src/ingest.js";
import { forecast } from "../src/forecast.js";
import { generateSample, SAMPLE_FILES } from "../src/sample.js";

// A judge who opens the demo must see numbers that make sense: no thousand-rupee packets of salt, no negative prices, no pack of 90
// toilet rolls that lasts four weeks, no runway where everything is three weeks overdue. These tests check the generated data itself,
// for today and for dates weeks from now (the server counts the sample back from whatever day it is opened).
const DAY = 86_400_000;
const todayISO = new Date().toISOString().slice(0, 10);
const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * DAY).toISOString().slice(0, 10);
const BOUNDS = { // major units per line
  consumable: { USD: [0.5, 150], INR: [10, 3000] } as Record<string, [number, number]>,
  durable: { USD: [5, 800], INR: [300, 60000] } as Record<string, [number, number]>,
};

const OPENED = [0, 14, 45]; // days from now at which a judge might open the demo

test("every sample household, opened today or weeks from now: prices, quantities and dates are the kind a real household has", () => {
  for (const file of SAMPLE_FILES) {
    for (const offset of OPENED) {
      const anchor = addDays(todayISO, offset);
      const where = `${file} opened ${offset} days from now`;
      {
      const db = openDb(":memory:");
      const r = ingestOrders(db, "h", generateSample(file, anchor), Date.parse(anchor));
      assert.ok(r.imported >= 100 && r.imported <= 400, `${where}: ${r.imported} rows is a believable two-year history`);
      assert.ok(r.duplicates / r.rowsRead <= 0.1 && (r.skippedCount + r.duplicates) / r.rowsRead <= 0.2, "messy, but not mostly garbage");
      const rows = db.prepare("SELECT title, ordered_at, qty, pack_units, unit_price_cents, currency, kind, status FROM orders WHERE household = 'h'").all() as unknown as { title: string; ordered_at: string; qty: number; pack_units: number; unit_price_cents: number; currency: string; kind: string; status: string }[];
      for (const o of rows) {
        const cur = o.currency === "INR" ? "INR" : "USD";
        const major = o.unit_price_cents / 100;
        const b = (o.kind === "durable" ? BOUNDS.durable : BOUNDS.consumable)[cur];
        assert.ok(major >= b[0] && major <= b[1], `${where}: ${o.title}: ${major} ${o.currency} is outside ${b[0]} to ${b[1]}`);
        assert.ok(o.qty >= 1 && o.qty <= 3, `${where}: ${o.title}: quantity ${o.qty}`);
        assert.ok(o.ordered_at <= anchor, `${where}: ${o.title}: ordered ${o.ordered_at}, after the day the export was made`);
        assert.ok(o.ordered_at >= addDays(anchor, o.kind === "durable" ? -365 * 5 : -800), `${where}: ${o.title}: ordered ${o.ordered_at}, too long ago`);
      }
      const currencies = new Set(rows.map((o) => o.currency));
      assert.equal(currencies.size, 1, "one household, one currency");
      // the same product costs about the same every time (a few percent of noise, never a different price class)
      const byTitle = new Map<string, number[]>();
      for (const o of rows.filter((x) => x.kind === "consumable")) byTitle.set(o.title.slice(0, 18), [...(byTitle.get(o.title.slice(0, 18)) ?? []), o.unit_price_cents]);
      for (const [t, ps] of byTitle) assert.ok(Math.max(...ps) / Math.min(...ps) < 1.15, `${where}: ${t}: price varies ${Math.min(...ps)} to ${Math.max(...ps)}`);
      }
    }
  }
});

test("every sample household, opened today or weeks from now: the runway is plausible, not a wall of overdue or a wall of fine", () => {
  for (const file of SAMPLE_FILES) {
    for (const offset of OPENED) {
      const anchor = addDays(todayISO, offset);
      const where = `${file} opened ${offset} days from now`;
      {
      const db = openDb(":memory:");
      ingestOrders(db, "h", generateSample(file, anchor), Date.parse(anchor));
      const runway = forecast(db, "h", Date.parse(anchor));
      assert.ok(runway.length >= 5, `${where}: ${runway.length} products forecast`);
      for (const i of runway) {
        const packLasts = i.packUnits / i.unitsPerDay;
        assert.ok(packLasts >= 7 && packLasts <= 150, `${where}: ${i.name}: a pack lasts ${packLasts.toFixed(0)} days`);
        assert.ok(i.windowDays <= 0.6 * packLasts, `${where}: ${i.name}: a ±${i.windowDays} day window on a ${packLasts.toFixed(0)}-day pack says almost nothing`);
        assert.ok(i.daysLeft >= -35 && i.daysLeft <= 240, `${where}: ${i.name}: ${i.daysLeft} days left`);
        assert.ok(i.unitPriceCents > 0 && Number.isFinite(Date.parse(i.runoutDate)), `${where}: ${i.name}: price or date is nonsense`);
        assert.ok(i.purchases >= 4, `${where}: ${i.name}: only ${i.purchases} purchases`);
      }
      const due = runway.filter((i) => i.daysLeft <= 30).length;
      const longOverdue = runway.filter((i) => i.daysLeft < -14).length;
      assert.ok(due >= 2, `${where}: only ${due} items due in a month: the demo would have nothing to say`);
      assert.ok(longOverdue <= Math.ceil(runway.length * 0.2), `${where}: ${longOverdue} of ${runway.length} items are more than two weeks overdue`);
      assert.ok(runway.some((i) => i.daysLeft > 14), `${where}: something is comfortably stocked, so the list is not all alarm`);
      }
    }
  }
});

test("appliances were bought before the recalls that the demo is about, so the headline matches are not 'bought after the recall'", () => {
  const db = openDb(":memory:");
  ingestOrders(db, "h", generateSample("sample-orders.csv", todayISO));
  const foodi = db.prepare("SELECT ordered_at FROM orders WHERE title LIKE '%Foodi%'").get() as { ordered_at: string };
  assert.ok(foodi.ordered_at < "2025-05-01", "the SharkNinja Foodi recall is 2025-05-01");
  const fam = openDb(":memory:");
  ingestOrders(fam, "h", generateSample("sample-family.csv", todayISO));
  const avent = fam.prepare("SELECT ordered_at FROM orders WHERE title LIKE '%Avent%'").get() as { ordered_at: string };
  assert.ok(avent.ordered_at < "2023-08-03", "the Philips Avent monitor recall is 2023-08-03");
});

test("the sample generator is deterministic for a given day and independent between households", () => {
  assert.equal(generateSample("sample-orders.csv", "2026-10-23"), generateSample("sample-orders.csv", "2026-10-23"));
  assert.notEqual(generateSample("sample-orders.csv", "2026-10-23"), generateSample("sample-orders.csv", "2026-10-24"));
});

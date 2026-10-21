import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../src/db.js";
import { ingestOrders } from "../src/ingest.js";
import { forecast } from "../src/forecast.js";
import { storeRecalls, type RecallRecord } from "../src/recallIndex.js";
import { processNewRecalls, listAlerts } from "../src/alerts.js";

const load = (name: string) => readFileSync(`data/${name}`, "utf8");
const rec = (id: string, title: string, text: string, date: string): RecallRecord => ({ source: "cpsc", extId: id, region: "US", date, title, product: "", text, url: "https://www.cpsc.gov/x", hazard: "Hazard", remedy: "Stop using it" });

test("the family sample imports cleanly and the baby-product cadence is learned", () => {
  const db = openDb(":memory:");
  const r = ingestOrders(db, "fam", load("sample-family.csv"));
  assert.ok(r.imported > 200 && r.duplicates >= 1);
  assert.deepEqual(Object.keys(r.currencies), ["USD"]);
  const runway = forecast(db, "fam");
  const formula = runway.find((i) => /Similac/.test(i.title));
  const diapers = runway.find((i) => /Pampers/.test(i.title));
  assert.ok(formula && diapers, "consumables are forecast");
  assert.ok(formula.confidence === "high" && diapers.confidence === "high");
  assert.ok(runway.every((i) => !/Philips Avent|Anker|Oster|Fisher/.test(i.title)), "one-off durables are never restocked");
});

test("a recall of the monitor the family owns alerts them, by model number", () => {
  const db = openDb(":memory:");
  ingestOrders(db, "fam", load("sample-family.csv"));
  ingestOrders(db, "home", load("sample-orders.csv"));
  const monitor = rec("910", "Philips Avent Digital Video Baby Monitors Recalled Due to Overheating Hazard", "Philips Avent digital video baby monitors models SCD630 SCD843", "2023-08-03");
  const r = processNewRecalls(db, [monitor]);
  assert.deepEqual([...r.households], ["fam"], "the home sample owns no Avent monitor");
  const [a] = listAlerts(db, "fam");
  assert.equal(a.match.level, "likely");
  assert.ok(a.match.evidence.some((e) => /SCD843/.test(e)));
});

test("the India sample is read day-first, in rupees, and forecasts staples", () => {
  const db = openDb(":memory:");
  const r = ingestOrders(db, "in", load("sample-india.csv"));
  assert.equal(r.dateOrder, "day-first");
  assert.deepEqual(Object.keys(r.currencies), ["INR"]);
  const runway = forecast(db, "in");
  const atta = runway.find((i) => /Atta/.test(i.title));
  assert.ok(atta && atta.currency === "INR" && atta.confidence === "high");
  assert.ok(atta.unitPriceCents > 40000 && atta.unitPriceCents < 70000, `₹5xx per pack, got ${atta.unitPriceCents}`);
  assert.ok(Math.abs(atta.unitsPerDay - 1 / 26) < 0.02, "about one pack every 26 days");
  assert.ok(runway.every((i) => !/Air Fryer|Mixer/.test(i.title)));
});

test("short product words only match whole words: infant formula is a consumable, a vacuum attachment is not food", async () => {
  const { classify } = await import("../src/normalize.js");
  assert.equal(classify("Similac Pro-Advance Infant Formula Powder, 36 oz"), "consumable");
  assert.equal(classify("Dyson V8 Crevice Attachment Tool"), "other");
  assert.equal(classify("Lasko Oscillating Tower Fan"), "durable");
  assert.equal(classify("Aashirvaad Select Sharbati Atta, 10 kg"), "consumable");
});

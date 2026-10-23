import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../src/db.js";
import { ingestOrders } from "../src/ingest.js";
import { forecast } from "../src/forecast.js";
import type { RecallRecord } from "../src/recallIndex.js";
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

test("the pantry sample is read in dollars and forecasts staples, not appliances", () => {
  const db = openDb(":memory:");
  const r = ingestOrders(db, "pan", load("sample-pantry.csv"));
  assert.deepEqual(Object.keys(r.currencies), ["USD"]);
  const runway = forecast(db, "pan");
  const coffee = runway.find((i) => /Folgers/.test(i.title));
  assert.ok(coffee && coffee.currency === "USD" && coffee.confidence === "high");
  assert.ok(coffee.unitPriceCents > 1100 && coffee.unitPriceCents < 1700, `about $14 a canister, got ${coffee.unitPriceCents}`);
  assert.ok(Math.abs(coffee.unitsPerDay - 1 / 26) < 0.02, "about one canister every 26 days");
  assert.ok(runway.every((i) => !/Airfryer|Mixer|Anker/.test(i.title)));
});

test("short product words only match whole words: infant formula is a consumable, a vacuum attachment is not food", async () => {
  const { classify } = await import("../src/normalize.js");
  assert.equal(classify("Similac Pro-Advance Infant Formula Powder, 36 oz"), "consumable");
  assert.equal(classify("Dyson V8 Crevice Attachment Tool"), "other");
  assert.equal(classify("Lasko Oscillating Tower Fan"), "durable");
  assert.equal(classify("Aashirvaad Select Sharbati Atta, 10 kg"), "consumable");
});

test("'vacuum' in a food or a flask is read correctly, not as a cleaner", async () => {
  const { classify } = await import("../src/normalize.js");
  assert.equal(classify("Tata Salt Vacuum Evaporated Iodised Salt, 1 kg"), "consumable", "vacuum-evaporated salt is food");
  assert.equal(classify("Dyson V8 Cordless Vacuum Cleaner"), "durable");
  assert.equal(classify("Eufy RoboVac Robot Vacuum Cleaner"), "durable");
  assert.equal(classify("Milton Thermosteel Vacuum Flask 1 L"), "durable");
});

test("friendly names say what the product is, for staples as well as appliances", async () => {
  const { friendlyName } = await import("../src/normalize.js");
  assert.equal(friendlyName("Tata Salt Vacuum Evaporated Iodised Salt, 1 kg"), "Tata salt");
  assert.equal(friendlyName("Aashirvaad Select Premium Sharbati Atta, 10 kg"), "Aashirvaad atta");
  assert.equal(friendlyName("Fortune Sunlite Refined Sunflower Oil, 5 L Jar"), "Fortune sunflower oil");
  assert.equal(friendlyName("Dyson V8 Cordless Vacuum Cleaner"), "Dyson cordless vacuum");
  assert.equal(friendlyName("Amul Taaza Toned Milk Powder, 1 kg"), "Amul milk powder");
});

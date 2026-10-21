import test from "node:test";
import assert from "node:assert/strict";
import { parseDate, parseMoneyCents, productKey, packUnits, classify, sameProduct } from "../src/normalize.js";
import { parseCsv } from "../src/csv.js";

test("parseDate handles the formats seen in exports", () => {
  assert.equal(parseDate("2025-03-04T10:00:00Z"), "2025-03-04");
  assert.equal(parseDate("12/21/2024"), "2024-12-21");
  assert.equal(parseDate("21/12/2024"), "2024-12-21"); // only valid day-first
  assert.equal(parseDate("03/04/2025", true), "2025-04-03");
  assert.equal(parseDate("03/04/2025", false), "2025-03-04");
  assert.equal(parseDate("Feb 20, 2025"), "2025-02-20");
  assert.equal(parseDate("20 February 2025"), "2025-02-20");
  assert.equal(parseDate("31/02/2025"), null);
  assert.equal(parseDate("garbage"), null);
});

test("parseMoneyCents handles symbols and separators", () => {
  assert.equal(parseMoneyCents("$1,299.00"), 129900);
  assert.equal(parseMoneyCents("USD 12.5"), 1250);
  assert.equal(parseMoneyCents("12,50 €"), 1250);
  assert.equal(parseMoneyCents("n/a"), null);
});

test("productKey ignores pack sizes and punctuation", () => {
  assert.ok(sameProduct(productKey("Bounty Select-A-Size Paper Towels, 12 Triple Rolls"), productKey("BOUNTY Paper Towels Select a Size 12 Triple Rolls Family Pack")));
  assert.ok(!sameProduct(productKey("Tide PODS Laundry Detergent, 81 Count"), productKey("Charmin Ultra Soft Toilet Paper, 18 Mega Rolls")));
});

test("packUnits and classify", () => {
  assert.equal(packUnits("Tide PODS 81 Count"), 81);
  assert.equal(packUnits("Colgate Total, Pack of 4"), 4);
  assert.equal(classify("Ninja Foodi Pressure Cooker OP302"), "durable");
  assert.equal(classify("Instant Pot replacement filter"), "consumable");
  assert.equal(classify("Gift card"), "other");
});

test("parseCsv handles quotes, escaped quotes, CRLF, BOM", () => {
  const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n1,2');
  assert.deepEqual(rows, [["a", "b"], ["x, y", 'say "hi"'], ["1", "2"]]);
});

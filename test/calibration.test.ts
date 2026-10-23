import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../src/db.js";
import { ingestOrders } from "../src/ingest.js";
import { backtestCases } from "../src/forecast.js";

// The stated +/- window is only honest if the real next purchase usually falls inside it. `npm run backtest` prints the full table;
// this pins the property so a future change to the forecaster cannot quietly make the window decorative. (Synthetic households: this
// tests the statistics, not real shopping behaviour; run the backtest on a real export to see that.)
const cases = ["sample-orders.csv", "sample-family.csv", "sample-pantry.csv"].flatMap((f) => {
  const db = openDb(":memory:");
  ingestOrders(db, "h", readFileSync(`data/${f}`, "utf8"));
  return backtestCases(db, "h");
});
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

test("the stated window contains the real next purchase about 80% of the time, not about half", () => {
  assert.ok(cases.length > 300, `${cases.length} rolling-origin predictions`);
  const covered = cases.filter((c) => Math.abs(c.errorDays) <= c.windowDays).length / cases.length;
  assert.ok(covered >= 0.7 && covered <= 0.9, `coverage ${(covered * 100).toFixed(0)}%`);
});

test("higher confidence really means smaller errors", () => {
  const err = (c: string) => mean(cases.filter((x) => x.confidence === c).map((x) => Math.abs(x.errorDays)));
  assert.ok(err("high") < err("medium"), `mean error: high ${err("high").toFixed(2)} d, medium ${err("medium").toFixed(2)} d`);
});

// How good is the forecast, measured the only honest way: predict each purchase from the history that came before it.
//   npm run backtest                     the three bundled synthetic households
//   npm run backtest -- my-orders.csv    your own order export (any file the importer reads)
// For every product with enough history, at every purchase k >= 4, the forecaster sees purchases 1..k and predicts when the next
// purchase will happen; the error is the actual next purchase date minus that prediction. A prediction "covers" when the actual date
// fell inside the stated window (the +/- days Hearth shows). Results are grouped by the confidence Hearth printed.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { openDb } from "../src/db.js";
import { ingestOrders } from "../src/ingest.js";
import { backtestCases, type BacktestCase } from "../src/forecast.js";

const files = process.argv.slice(2).filter((a) => a.endsWith(".csv"));
const inputs = files.length ? files : ["data/sample-orders.csv", "data/sample-family.csv", "data/sample-pantry.csv"];

type Case = BacktestCase & { household: string };
const cases: Case[] = [];
for (const file of inputs) {
  const db = openDb(":memory:");
  const hh = basename(file);
  ingestOrders(db, hh, readFileSync(file, "utf8"));
  for (const c of backtestCases(db, hh)) cases.push({ ...c, household: hh });
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : "n/a");
const report = (label: string, cs: Case[]) => {
  const abs = cs.map((c) => Math.abs(c.errorDays));
  const within = cs.filter((c) => Math.abs(c.errorDays) <= c.windowDays).length;
  const within3 = cs.filter((c) => Math.abs(c.errorDays) <= c.windowDays * 3).length;
  console.log(`${label.padEnd(14)} ${String(cs.length).padStart(5)} predictions   median |error| ${median(abs).toFixed(1).padStart(5)} d   inside the stated window ${pct(within, cs.length).padStart(4)}   inside 3x the window ${pct(within3, cs.length).padStart(4)}`);
};
console.log(`Backtest of the Hearth forecaster on: ${inputs.join(", ")}\n`);
report("all", cases);
for (const c of ["high", "medium", "low"]) report(`${c} confidence`, cases.filter((x) => x.confidence === c));
if (!cases.length) console.log("\nNo product has more than four purchases, so there is nothing to backtest yet.");

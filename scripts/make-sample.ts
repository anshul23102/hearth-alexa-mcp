// Writes the SYNTHETIC sample households to data/ (the files the tests and the offline docs use). The running server generates the same
// households fresh, dated from today, so this script is only needed to refresh those files:  npm run sample [yyyy-mm-dd]
import { writeFileSync } from "node:fs";
import { generateSample, SAMPLE_FILES } from "../src/sample.js";

const anchor = process.argv[2] ?? new Date().toISOString().slice(0, 10);
for (const file of SAMPLE_FILES) {
  const csv = generateSample(file, anchor);
  writeFileSync(new URL(`../data/${file}`, import.meta.url), csv);
  console.log(`${file}: wrote ${csv.split("\n").length - 2} rows, dated back from ${anchor}`);
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../src/db.js";
import { ingestOrders } from "../src/ingest.js";
import { listAlerts, processNewRecalls, setRecallStatus, withRemedy } from "../src/alerts.js";
import { eraseHousehold } from "../src/actions.js";
import { storeRecalls, type RecallRecord } from "../src/recallIndex.js";

// CPSC's own figure is that under half of recalled units are ever corrected. An alert that ends at "you were told" has not helped,
// so Hearth records what the household did next, and says how many recalls are still open.
const CSV = readFileSync("data/sample-orders.csv", "utf8");
const FOODI: RecallRecord = { source: "cpsc", extId: "900", region: "US", date: "2026-10-20", title: "SharkNinja Recalls Foodi Multi-Function Pressure Cookers Due to Burn Hazard", product: "", text: "Foodi pressure cookers models OP300 OP301 OP302", url: "https://www.cpsc.gov/x", hazard: "Burn hazard", remedy: "Stop using it and ask for a free lid" };
const setup = () => {
  const db = openDb(":memory:");
  ingestOrders(db, "h", CSV);
  storeRecalls(db, "cpsc", [FOODI]); // the notice is in the index, as it always is by the time an alert exists
  processNewRecalls(db, [FOODI]);
  const match = listAlerts(db, "h")[0].match;
  return { db, match };
};

test("progress on a recall is recorded, merged into the results, and counted as open until closed", () => {
  const { db, match } = setup();
  assert.equal(withRemedy(db, "h", [match]).open, 1, "a fresh alert is open");
  assert.deepEqual(setRecallStatus(db, "h", match.recall.id, match.owned.productKey, "stopped_using"), { ok: true });
  assert.equal(withRemedy(db, "h", [match]).matches[0].remedy, "stopped_using");
  assert.equal(withRemedy(db, "h", [match]).open, 1, "stopping use is progress, but the recall is not closed");
  setRecallStatus(db, "h", match.recall.id, match.owned.productKey, "resolved");
  const after = withRemedy(db, "h", [match]);
  assert.equal(after.matches[0].remedy, "resolved");
  assert.equal(after.open, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE household = 'h' AND action = 'recall_status'").get()!.n, 2, "each change is in the audit log");
});

test("a household cannot record progress on a recall or product it has no match for, or touch another household's", () => {
  const { db, match } = setup();
  assert.equal(setRecallStatus(db, "h", "cpsc:nope", match.owned.productKey, "resolved").ok, false, "unknown recall");
  assert.equal(setRecallStatus(db, "h", match.recall.id, "asin:nothing", "resolved").ok, false, "a product this household never bought");
  assert.equal(setRecallStatus(db, "h", "not-an-id", match.owned.productKey, "resolved").ok, false);
  ingestOrders(db, "other", CSV);
  setRecallStatus(db, "other", match.recall.id, match.owned.productKey, "resolved");
  assert.equal(withRemedy(db, "h", [match]).open, 1, "progress is per household");
});

test("erasing a household also erases its recall progress", () => {
  const { db, match } = setup();
  setRecallStatus(db, "h", match.recall.id, match.owned.productKey, "resolved");
  eraseHousehold(db, "h");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM recall_actions WHERE household = 'h'").get()!.n, 0);
});

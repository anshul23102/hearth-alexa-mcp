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

// ---- reminders -------------------------------------------------------------------------------------------------------------
import { dueReminders, MAX_REMINDERS } from "../src/alerts.js";
const HOUR = 3_600_000;
const seen = (db: ReturnType<typeof openDb>) => db.prepare("UPDATE alerts SET status = 'seen'").run(); // the household has looked at the first alert

test("a recall still open after the delay comes back as a new alert, then eases off after three reminders", () => {
  const { db, match } = setup();
  seen(db);
  const t0 = Date.now();
  assert.equal(dueReminders(db, t0 + 71 * HOUR, 72 * HOUR).size, 0, "not before the delay");
  assert.deepEqual([...dueReminders(db, t0 + 73 * HOUR, 72 * HOUR)], ["h"]);
  const again = listAlerts(db, "h", { onlyNew: true });
  assert.equal(again.length, 1);
  assert.equal(again[0].reminders, 1, "the alert says it is a reminder");
  assert.equal(dueReminders(db, t0 + 74 * HOUR, 72 * HOUR).size, 0, "a reminder that has not been looked at is not repeated");
  for (let i = 2; i <= MAX_REMINDERS + 1; i++) { seen(db); dueReminders(db, t0 + (73 + 73 * (i - 1)) * HOUR, 72 * HOUR); }
  assert.equal(listAlerts(db, "h")[0].reminders, MAX_REMINDERS, "never more than three");
  assert.match(JSON.stringify(db.prepare("SELECT detail FROM audit WHERE household = 'h' AND action = 'recall_reminder'").all()), /reminder/, "reminders are logged");
  assert.ok(match);
});

test("no reminder once the household resolves or rules out the recall, and none for a merely possible match", () => {
  const { db, match } = setup();
  seen(db);
  setRecallStatus(db, "h", match.recall.id, match.owned.productKey, "resolved");
  assert.equal(dueReminders(db, Date.now() + 500 * HOUR, 72 * HOUR).size, 0);
  const other = setup();
  seen(other.db);
  other.db.prepare("UPDATE alerts SET level = 'possible'").run();
  assert.equal(dueReminders(other.db, Date.now() + 500 * HOUR, 72 * HOUR).size, 0, "a reminder to check a label would be nagging");
  // stopping use or asking for the fix is progress, but the recall is not closed, so the reminder still comes
  const third = setup();
  seen(third.db);
  setRecallStatus(third.db, "h", third.match.recall.id, third.match.owned.productKey, "stopped_using");
  assert.equal(dueReminders(third.db, Date.now() + 500 * HOUR, 72 * HOUR).size, 1);
});

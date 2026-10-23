import test from "node:test";
import assert from "node:assert/strict";
import { audit, auditHead, auditPin, openDb, verifyAudit } from "../src/db.js";

// A hash chain checked only against itself cannot catch someone who rewrites every hash consistently. A fingerprint written down
// outside the database (the page keeps one) can: the chain was extended, or it was not the same chain.
const fill = (db: ReturnType<typeof openDb>, n: number) => { for (let i = 0; i < n; i++) audit(db, "h", `action_${i}`, { i }, 1_700_000_000_000 + i); };

test("a pinned fingerprint stays valid as honest entries are appended", () => {
  const db = openDb(":memory:");
  fill(db, 5);
  const pin = auditHead(db, "h")!;
  assert.equal(pin.seq, 5);
  audit(db, "h", "later", { ok: true }, 1_700_000_100_000);
  assert.equal(auditPin(db, "h", pin.seq, pin.hash), "unchanged");
  assert.notEqual(auditHead(db, "h")!.hash, pin.hash, "the head moves with every entry");
});

test("rewriting history, even with every hash recomputed so the chain verifies, no longer matches the pinned fingerprint", () => {
  const db = openDb(":memory:");
  fill(db, 5);
  const pin = auditHead(db, "h")!;
  // The attacker: replay the whole history with one entry changed, producing a perfectly valid chain.
  db.prepare("DELETE FROM audit WHERE household = 'h'").run();
  for (let i = 0; i < 5; i++) audit(db, "h", i === 2 ? "nothing_to_see" : `action_${i}`, { i }, 1_700_000_000_000 + i);
  assert.equal(verifyAudit(db, "h").ok, true, "the forged chain is internally consistent: the self-check alone is fooled");
  assert.equal(auditPin(db, "h", pin.seq, pin.hash), "changed", "the fingerprint kept outside the database is not");
});

test("deleting the tail of the history is reported as missing", () => {
  const db = openDb(":memory:");
  fill(db, 5);
  const pin = auditHead(db, "h")!;
  db.prepare("DELETE FROM audit WHERE household = 'h' AND seq > 3").run();
  assert.equal(auditPin(db, "h", pin.seq, pin.hash), "missing");
});

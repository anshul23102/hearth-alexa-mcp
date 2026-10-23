import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb, verifyAudit } from "../src/db.js";
import { ingestOrders } from "../src/ingest.js";
import { forecast } from "../src/forecast.js";
import { confirm, issueApprovalCode, propose, recentAudit, simulatedStore } from "../src/actions.js";

// A prompt-injected model can claim "the user agreed". These tests pin what it cannot do: place an order without a proof of a person.
const CSV = readFileSync("data/sample-orders.csv", "utf8");
const world = () => {
  const db = openDb(":memory:");
  ingestOrders(db, "h", CSV);
  const plan = () => propose(db, "h", forecast(db, "h"), { withinDays: 21, budgetCents: 6000 });
  return { db, plan };
};
const byVoice = (db: ReturnType<typeof openDb>, id: string, code: string, now = Date.now()) => confirm(db, simulatedStore, "h", id, { code }, now);

test("the voice route needs the code from the card: no code, a guess, or another plan's code all fail", async () => {
  const { db, plan } = world();
  const a = plan(), b = plan();
  assert.ok(a.lines.length > 0);
  const none = await byVoice(db, a.id, "1234");
  assert.equal(none.ok, false);
  assert.match((none as any).error, /approval code/i, "nothing has been shown on a card yet, so no code can be right");
  const codeA = (issueApprovalCode(db, "h", a.id) as { code: string }).code;
  const codeB = (issueApprovalCode(db, "h", b.id) as { code: string }).code;
  const wrong = codeA === codeB ? "0000" : codeB; // a real code, but for a different plan
  assert.equal((await byVoice(db, a.id, wrong === codeA ? "9999" : wrong)).ok, false, "a code only approves the plan it was issued for");
  const ok = await byVoice(db, a.id, codeA);
  assert.equal(ok.ok, true);
  const audit = recentAudit(db, "h", 20).find((r: any) => r.action === "confirm_restock") as any;
  assert.match(JSON.stringify(audit), /"consent":"code"/, "the audit log records how consent was proven");
  assert.equal(verifyAudit(db, "h").ok, true);
});

test("three wrong codes lock the plan, even for the right code afterwards", async () => {
  const { db, plan } = world();
  const p = plan();
  const code = (issueApprovalCode(db, "h", p.id) as { code: string }).code;
  const wrong = code === "0000" ? "1111" : "0000";
  for (let i = 0; i < 3; i++) assert.equal((await byVoice(db, p.id, wrong)).ok, false);
  const late = await byVoice(db, p.id, code);
  assert.equal(late.ok, false);
  assert.match((late as any).error, /locked/);
});

test("guessing across new plans is capped per household per hour", async () => {
  const { db, plan } = world();
  const now = Date.now();
  for (let i = 0; i < 3; i++) { // three plans, three wrong guesses each: nine failures
    const p = plan();
    const code = (issueApprovalCode(db, "h", p.id, now) as { code: string }).code;
    const wrong = code === "0000" ? "1111" : "0000";
    for (let j = 0; j < 3; j++) await byVoice(db, p.id, wrong, now);
  }
  const p = plan();
  const code = (issueApprovalCode(db, "h", p.id, now) as { code: string }).code;
  const blocked = await byVoice(db, p.id, code, now);
  assert.equal(blocked.ok, false);
  assert.match((blocked as any).error, /paused/, "even the right code is refused once the household has been guessed at");
  assert.equal((await confirm(db, simulatedStore, "h", p.id, "app", now)).ok, true, "the person can still press the button on the card");
});

test("the card's button is its own proof of a person, and the audit log says so", async () => {
  const { db, plan } = world();
  const p = plan();
  const r = await confirm(db, simulatedStore, "h", p.id, "app");
  assert.equal(r.ok, true);
  assert.match(JSON.stringify(recentAudit(db, "h", 20)), /"consent":"app"/);
});

test("codes are stored only as hashes and expire with the plan", async () => {
  const { db, plan } = world();
  const p = plan();
  const code = (issueApprovalCode(db, "h", p.id) as { code: string }).code;
  const row = db.prepare("SELECT approval_hash FROM proposals WHERE id = ?").get(p.id) as { approval_hash: string };
  assert.ok(!row.approval_hash.includes(code) && row.approval_hash.length === 64, "a database leak does not reveal a code");
  const later = p.expiresAt + 1000;
  assert.equal((issueApprovalCode(db, "h", p.id, later) as any).ok, false, "no new code for an expired plan");
  assert.equal((await byVoice(db, p.id, code, later)).ok, false, "an expired plan cannot be approved");
});

test("the offline router never confirms on a bare yes, and understands spoken codes", async () => {
  const { localStep, spokenCode, modelTools } = await import("../web/agent.js" as string) as any;
  assert.equal(spokenCode("confirm 4827"), "4827");
  assert.equal(spokenCode("four eight two seven"), "4827");
  assert.equal(spokenCode("4 8 2 7"), "4827");
  assert.equal(spokenCode("order 12 things"), null);
  assert.equal(spokenCode("my code is 48279"), null);
  const plan = [
    { role: "user", content: [{ type: "text", text: "plan a restock" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "plan_restock", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", text: "Here is a plan.", structured: { view: "proposal", proposal: { id: "prop_x" } } }] },
  ];
  const ask = (text: string) => localStep([...plan, { role: "user", content: [{ type: "text", text }] }], { sampleCsv: "" }).content[0];
  assert.equal(ask("yes, place it").type, "text", "a spoken yes is not proof of a person");
  assert.match(ask("yes").text, /approval code/i);
  const confirmed = ask("confirm four eight two seven");
  assert.equal(confirmed.name, "confirm_restock");
  assert.deepEqual(confirmed.input, { proposalId: "prop_x", approvalCode: "4827" });
  const tools = [{ name: "a", _meta: { ui: { visibility: ["app"] } } }, { name: "b", _meta: { ui: { visibility: ["model", "app"] } } }, { name: "c" }];
  assert.deepEqual(modelTools(tools).map((t: any) => t.name), ["b", "c"], "the host never offers app-only tools to the model");
});

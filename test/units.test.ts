import test from "node:test";
import assert from "node:assert/strict";
import { friendlyName } from "../src/normalize.js";
import { shortHazard, modelTokens } from "../src/recalls.js";
import { openDb } from "../src/db.js";
import { reserveBedrockCall, bedrockStep, toConverse, fromConverse, hasBedrockCredentials, type Converser, type WireMessage } from "../src/agent.js";
import type { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

test("friendlyName gives something sayable", () => {
  assert.equal(friendlyName("BOUNTY Paper Towels Select a Size 12 Triple Rolls"), "Bounty paper towels");
  assert.equal(friendlyName("Glad ForceFlex Tall Kitchen Trash Bags, 80 Count"), "Glad trash bags");
  assert.equal(friendlyName("Mystery Item 9000"), "Mystery Item 9000");
});

test("shortHazard and modelTokens", () => {
  assert.equal(shortHazard("SharkNinja Recalls Foodi Pressure Cookers Due to Burn Hazard; Serious Burn Injuries"), "a burn hazard");
  assert.equal(shortHazard("Nothing parseable here"), "a safety hazard");
  assert.deepEqual(modelTokens("Ninja Foodi OP302 and ab-12 cooker").sort(), ["AB12", "OP302"]);
});

test("Bedrock adapter maps wire messages to Converse and back", async () => {
  const wire: WireMessage[] = [
    { role: "user", content: [{ type: "text", text: "what's low?" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "household_runway", input: { withinDays: 30 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", text: "3 items", isError: false }] },
  ];
  const conv = toConverse(wire);
  assert.equal(conv[1].content![0].toolUse!.name, "household_runway");
  assert.equal(conv[2].content![0].toolResult!.status, "success");

  let seen: any;
  const fake: Converser = {
    async send(cmd: ConverseCommand) {
      seen = cmd.input;
      return { output: { message: { role: "assistant", content: [{ text: "Three things." }, { toolUse: { toolUseId: "t2", name: "check_recalls", input: {} } }] } } };
    },
  };
  const out = await bedrockStep(fake, wire, [{ name: "household_runway", description: "d", inputSchema: { type: "object" } }], "test-model");
  assert.equal(seen.modelId, "test-model");
  assert.match(seen.system[0].text, /spoken aloud/);
  assert.equal(seen.toolConfig.tools[0].toolSpec.name, "household_runway");
  assert.deepEqual(out.content.map((b) => b.type), ["text", "tool_use"]);
  assert.equal(fromConverse(undefined).content.length, 0);
});

test("Bedrock mode only turns on with credentials", () => {
  assert.equal(hasBedrockCredentials({}), false);
  assert.equal(hasBedrockCredentials({ AWS_PROFILE: "x" }), true);
  assert.equal(hasBedrockCredentials({ AWS_PROFILE: "x", HEARTH_AGENT: "local" }), false);
});

test("free-plan guard: model calls are capped per day, persist, and reset tomorrow", () => {
  const db = openDb(":memory:");
  const day1 = Date.parse("2026-10-21T10:00:00Z");
  assert.deepEqual([1, 2, 3, 4].map(() => reserveBedrockCall(db, 3, day1).ok), [true, true, true, false]);
  assert.equal(reserveBedrockCall(db, 3, day1 + 3600_000).ok, false, "still capped later the same day");
  assert.equal(reserveBedrockCall(db, 3, Date.parse("2026-10-22T00:00:01Z")).ok, true, "a new UTC day starts fresh");
});

test("rupee prices in every common spelling are read, including 'Rs.' and lakh grouping", async () => {
  const { parseMoneyCents } = await import("../src/normalize.js");
  const cases: [string, number][] = [["Rs. 785.00", 78500], ["Rs.785.00", 78500], ["Rs 785", 78500], ["₹785.00", 78500], ["₹1,299.00", 129900], ["Rs. 1,299.50", 129950], ["Rs. 1,24,900.00", 12490000], ["INR 785.00", 78500], ["$26.99", 2699], ["12,50 €", 1250]];
  for (const [text, cents] of cases) assert.equal(parseMoneyCents(text), cents, text);
});

test("a missing price cannot make an item free: the forecast uses the usual price, and a plan never contains a zero-price line", async () => {
  const { openDb } = await import("../src/db.js");
  const { ingestOrders } = await import("../src/ingest.js");
  const { forecast } = await import("../src/forecast.js");
  const { propose } = await import("../src/actions.js");
  const rows = ["Order ID,Order Date,Product Name,ASIN,Quantity,Unit Price,Order Status"];
  for (let i = 0; i < 6; i++) rows.push(`o${i},2026-0${i + 1}-01,"Tide PODS Laundry Detergent 81 Count",B0TESTTIDE,1,${i === 5 ? "n/a" : "21.97"},Delivered`);
  rows.push('o9,2026-06-20,"Mystery Soap 100 Count",B0MYSTERY1,1,n/a,Delivered', 'o8,2026-05-20,"Mystery Soap 100 Count",B0MYSTERY1,1,n/a,Delivered', 'o7,2026-04-20,"Mystery Soap 100 Count",B0MYSTERY1,1,n/a,Delivered');
  const db = openDb(":memory:");
  const rep = ingestOrders(db, "h", rows.join("\n"), Date.parse("2026-06-25"));
  assert.ok(rep.repairedCount >= 4, "the unreadable prices are reported as repaired");
  const runway = forecast(db, "h", Date.parse("2026-08-30"));
  const tide = runway.find((i) => /Tide/.test(i.title))!;
  assert.equal(tide.unitPriceCents, 2197, "the last (unreadable) price does not make Tide free");
  const plan = propose(db, "h", runway, { withinDays: 60 }, Date.parse("2026-08-30"));
  assert.ok(plan.lines.every((l) => l.unitPriceCents > 0), "no zero-price line");
  assert.ok(plan.dropped.some((d) => /no price on record/.test(d.why)) || !runway.some((i) => /Mystery/.test(i.title)), "an item with no price at all is left out and says why");
});

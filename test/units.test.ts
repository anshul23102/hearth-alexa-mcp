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

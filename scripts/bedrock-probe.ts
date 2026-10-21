// Finds which Bedrock models this account can actually call: npm run bedrock:probe
// One tiny request per candidate (maxTokens 20), cheapest tiers only, so it costs a fraction of a cent in total.
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockClient, REGION, hasBedrockCredentials } from "../src/agent.js";

const prefix = REGION.startsWith("ap-southeast-2") ? "au" : REGION.startsWith("eu-") ? "eu" : REGION.startsWith("ap-") ? "apac" : "us";
const CANDIDATES = [
  `${prefix}.anthropic.claude-haiku-5-5`,
  `${prefix}.anthropic.claude-haiku-4-5-20251001-v1:0`,
  "apac.anthropic.claude-3-haiku-20240307-v1:0",
  "apac.amazon.nova-lite-v1:0",
  "apac.amazon.nova-micro-v1:0",
  "amazon.nova-lite-v1:0",
  "amazon.nova-micro-v1:0",
];

console.log(`region: ${REGION}`);
if (!hasBedrockCredentials()) { console.log("No AWS credentials in this shell: export AWS_BEARER_TOKEN_BEDROCK (or sign in with AWS_PROFILE) first."); process.exit(1); }
const worked: string[] = [];
for (const id of [...new Set(CANDIDATES)]) {
  try {
    const out = await bedrockClient().send(new ConverseCommand({ modelId: id, messages: [{ role: "user", content: [{ text: "Reply with the single word: ok" }] }], inferenceConfig: { maxTokens: 20, temperature: 0 } }));
    console.log(`  OK      ${id}  ->  ${out.output?.message?.content?.[0]?.text?.trim().slice(0, 30)}`);
    worked.push(id);
  } catch (e) {
    const err = e as Error;
    console.log(`  no      ${id}  (${err.name}: ${err.message.replace(/\s+/g, " ").slice(0, 90)})`);
  }
}
if (worked.length) console.log(`\nUse one of these:\n  export BEDROCK_MODEL_ID="${worked[0]}"\n  npm run bedrock:check`);
else { console.log("\nNo candidate worked. Free-plan accounts can be restricted from some models; this does not affect the rest of Hearth."); process.exit(2); }

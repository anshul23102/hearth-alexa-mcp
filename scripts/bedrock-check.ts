// Verifies your AWS setup end to end: npm run bedrock:check
// Sends one tiny Converse request using the same code path as the simulator and prints what happened.
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockClient, MODEL_ID, REGION, hasBedrockCredentials } from "../src/agent.js";

console.log(`region: ${REGION}\nmodel:  ${MODEL_ID}`);
if (!hasBedrockCredentials()) {
  console.log("\nNo AWS credentials found in this shell. Set AWS_PROFILE (after `aws sso login`) or AWS_BEARER_TOKEN_BEDROCK, then rerun.");
  process.exit(1);
}
try {
  const t0 = performance.now();
  const out = await bedrockClient().send(new ConverseCommand({
    modelId: MODEL_ID,
    messages: [{ role: "user", content: [{ text: "Reply with exactly: Hearth is connected." }] }],
    inferenceConfig: { maxTokens: 30, temperature: 0 },
  }));
  console.log(`\nOK in ${Math.round(performance.now() - t0)} ms: ${out.output?.message?.content?.[0]?.text}`);
  console.log(`tokens: in ${out.usage?.inputTokens} / out ${out.usage?.outputTokens}`);
} catch (e) {
  const err = e as Error & { $metadata?: { httpStatusCode?: number } };
  console.log(`\nFAILED: ${err.name} (HTTP ${err.$metadata?.httpStatusCode ?? "?"})\n${err.message}`);
  const hints: Record<string, string> = {
    AccessDeniedException: "Your identity may lack bedrock:InvokeModel, or Anthropic model access is not enabled/approved for this account.",
    ValidationException: "Usually the model ID. In EU/Asia regions use the matching inference-profile prefix (eu. / apac.) instead of us.",
    ResourceNotFoundException: "The model is not available in this region or the ID is wrong.",
    ThrottlingException: "Quota is low on a new account; wait a minute and retry, or request a quota increase.",
    CredentialsProviderError: "No usable credentials. Run `aws sso login` or set AWS_BEARER_TOKEN_BEDROCK.",
    ExpiredTokenException: "Credentials expired. Log in again.",
  };
  if (hints[err.name]) console.log(`hint: ${hints[err.name]}`);
  process.exit(1);
}

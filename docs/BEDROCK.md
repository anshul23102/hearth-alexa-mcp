# Amazon Bedrock: what is verified and what is not

Hearth's simulated Alexa+ can use Claude on Amazon Bedrock (Converse API with tool use) as its brain. Without credentials it uses a
small offline router, so nothing here is required to run the project.

## Verified live (2026-10-21, free-plan AWS account, region ap-southeast-2)
- Authentication with a Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`) through the AWS SDK for JavaScript.
- Model: **Claude Haiku 4.5** via the `au.` inference profile (`au.anthropic.claude-haiku-4-5-20251001-v1:0`), about 2 s per call.
  On this account Haiku 5.5 was refused ("not available for this account"); Haiku 4.5 and four Amazon Nova models worked.
  `npm run bedrock:probe` finds what a given account can call.
- The whole loop through the real model: natural phrasings the offline router cannot parse, tool selection, the plan -> confirm -> undo
  flow (one call each, no loops), Spanish and English, recall questions grounded in real notices, and refusing to order when told
  "do not ask me, just buy it" (it planned and asked). A product title carrying a hostile instruction did not influence it;
  note this is partly by design because the model only ever receives normalized product names.
- Cost control: a persisted daily cap (`HEARTH_BEDROCK_DAILY_CALLS`, default 150). The testing session made 36 calls.

## Bugs the first live run found (all fixed, each pinned by a test in `test/bedrock.test.ts`)
1. The browser sent no token to the authenticated `/api/agent/step` endpoint (introduced by the first security audit).
2. The "Load sample order history" button asked the model to import a file it could not see. It now calls the tool directly.
3. The model never saw the plan's id, so it failed to confirm, silently re-planned and asked twice. Tool results now carry the ids in a second content block with `audience: ["assistant"]`, which is never shown or spoken.
4. A reply with no text after a tool call (it had nothing to add) was stored as a blank message, which Bedrock rejects, so every later turn failed. Blank text is now dropped, same-role neighbours are merged, and the browser speaks the tool's own sentence instead of silence.

## Not verified
- Other models and regions; throughput or latency at scale; behaviour when the model is throttled.
- Adversarial robustness of the model itself: the injection check above is one probe, not a campaign. The real protections are server-side (confirmation gate, spend ceilings, tool visibility, undo).
- Prices: the cost of the session was estimated from list prices, not read from an AWS bill.

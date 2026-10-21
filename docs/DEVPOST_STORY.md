## The problem
Recalls get published, but owners are not reliably reached. CPSC's own FY2025 performance report puts the average correction rate across consumer product recalls at 44.55%, so more than half of recalled units are not remedied, and in January 2025 CPSC ordered Amazon to notify purchasers of 400,000+ hazardous products directly (Amazon is contesting the order). The hard part is the join: a recall is free text from a regulator in one country, an order is a marketplace title, and the two have to be matched without crying wolf.

Second, Alexa+ add-ons are MCP servers, and a server that can place orders can spend a customer's money on a model's say-so. A 2026 vendor survey reports most consumers are uncomfortable with agents buying for them and expect strong safeguards. I could not find a standard pattern for the basics: confirm, idempotent retry, undo, audit, spend ceilings.

I am not claiming Amazon has no recall or reorder features; it does. Hearth is a measured, open, testable reference implementation of those two layers for an Alexa+ household add-on, working from order history at the moment a household is talking to Alexa+.

## What it does
Hearth is a self-hosted MCP server (spec 2025-11-25, Streamable HTTP, OAuth 2.1 + PKCE).
- **Proactive, not just on request.** A background sync spots newly published notices, finds every household that owns the product through a brand index (1,250 owners among 5,000 households in 37 ms), stores an alert, and pushes it over an MCP resource subscription to the open session, so Alexa+ can say it the moment it matters. This is the notify-purchasers-on-publication obligation regulators are putting on marketplaces.
- **Owner-level recall matching across regulators.** It syncs the full public feeds (U.S. CPSC and Health Canada, 10,505 real notices) into a local index and matches each household's appliances on brand, product type and model number, showing the evidence. A match is "likely" only with a model-number hit; otherwise "possible, verify the label". In the demo it matches the real SharkNinja Foodi recall by model OP302.
- **Learns from messy, global data.** It imports order exports the way they really arrive: mixed date formats, many currencies, duplicate rows, cancellations, missing quantities, and the same product retitled between orders. It streams files of hundreds of thousands of rows on a worker thread.
- **Forecasts honestly.** When each consumable runs out, with a likely window and a confidence instead of a fake-precise date.
- **A safety layer for agent purchases.** plan_restock only proposes. confirm_restock needs an explicit yes, is idempotent, has operator-set per-order and daily ceilings the model cannot change, a 10-minute undo, and an audit log. The erase-my-data tool is hidden from the model.
- **Speaks the household's language.** English, Spanish and Hindi replies, locale-correct money, saved region and language preferences.
- **Shows, not just tells.** Results render as a thermal-receipt card through an MCP Apps view, with working Place order and Cancel order buttons that call tools back over MCP.

## Measured, not claimed
- Recall matching, on 1,669 cases built from real CPSC notices: the right recall surfaced 85.4% of the time; 0% false alerts on an unrelated product of the same brand; 0.4% on a third-party replacement part; 2.1% false "likely" on a wrong model number. The positives are an upper bound, because titles come from the notice itself.
- Scale on one laptop: 676,000 orders across 5,000 households imported in about 13 s; forecast per household under 1 ms and recall check about 0.2 ms median against 10,505 notices (ranges over repeated runs in docs/SCALE.md). A 500,000-row, 43.5 MB upload took 12.4 s while another client's requests stayed at 13 ms p99.
- 89 automated tests run through the official MCP SDK client, including chaos input, an attack suite (host spoofing, cross-site calls, CSRF, token replay, tenant isolation, path traversal, SQL metacharacters), and the spend ceilings.

## How I built it
A TypeScript MCP server on the official SDK with ten annotated tools, SQLite state per household, a ui:// resource for the MCP Apps view, and a hardened OAuth server (hashed tokens, rotating refresh tokens with reuse detection, single-use codes, mandatory PKCE). The Alexa+ add-on developer tools are partner-only, so the demo front end is a real MCP client and MCP Apps host in the browser. Claude on Amazon Bedrock (Converse API with tool use) can drive it as the brain; without AWS credentials a small offline router runs the same loop. Purchasing sits behind one StoreAdapter interface, the seam where Amazon's ordering APIs would plug in. It runs as a compiled build with readiness checks, Prometheus metrics, structured logs, graceful shutdown and verified database backups, and its audit log is hash-chained so tampering is detectable.

## Challenges
- **Retitled listings** split one product into two forecast series. Merging by ASIN, with a title-overlap fallback, fixed it.
- **False alarms.** A bare "12" from "12 Triple Rolls" was read as a model number, and a third-party "battery for Dyson V6" recall matched Dyson owners. Both are now fixed and covered by the evaluation harness.
- **A silent failure in the sandboxed iframe.** One quote typo made the card render blank with no error. The view script is now compiled in the test suite.
- **A self-audit that found real holes:** an unauthenticated paid model endpoint, all users sharing one household, no CSRF protection on consent. Each was fixed with a test (see SECURITY.md).

## What I learned
Honest uncertainty beats false precision, in forecasts and in recall matching. An agent that can spend money needs ceilings the model cannot raise, not just a confirm button. Measuring the matcher on real notices changed my design more than any amount of reasoning about it.

## Honest limits
The storefront is simulated, the sample orders are synthetic (so forecast accuracy on real purchases is untested), and there is no real Alexa+ device. The recall data is real. A manipulated model could still set the user-confirmed flag; the ceilings, undo and audit limit the damage, and the real fix needs a user-presence signal from the platform. SECURITY.md lists the residual risks. The Spanish and Hindi strings should be reviewed by native speakers.

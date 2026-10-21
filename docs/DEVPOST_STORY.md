## Inspiration
Households run on small recurring decisions that nobody tracks: when the paper towels will run out, or whether the pressure cooker in the cupboard was recalled. Alexa+ sits in the kitchen where those decisions happen, but it forgets the household between conversations. I wanted to give it a memory, and just as important, the judgment to act on that memory safely.

## What it does
Hearth is a self-hosted MCP server (spec 2025-11-25, Streamable HTTP) that gives Alexa+ durable household memory.
- **Learns from messy data.** It imports an order-history CSV the way real exports arrive: mixed date formats, currency symbols, duplicate rows, cancellations, missing quantities, and the same product retitled between orders (merged by ASIN, then by title overlap).
- **Forecasts honestly.** It estimates when each consumable runs out from the median days-per-unit across purchase gaps, and reports a likely window and a confidence instead of a fake-precise date.
- **Checks recalls.** It matches the appliances you own against live U.S. CPSC recall notices on brand, product type and model number, and shows the evidence. Only a model-number hit earns "likely"; anything weaker is "possible". In the demo it matches the real SharkNinja Foodi pressure cooker recall by model OP302.
- **Acts safely.** plan_restock only proposes. confirm_restock needs an explicit yes (and uses MCP elicitation when the client supports it), is idempotent so a retry never orders twice, and every order has a 10-minute undo. Every action goes into an audit log.
- **Remembers.** A budget cap and "never reorder this" persist per household across sessions.
- **Shows, not just tells.** Results render as a thermal-receipt card through an MCP Apps view, with working Place order and Cancel order buttons that call tools back over MCP.

## How I built it
A TypeScript MCP server on the official SDK with eight annotated tools, OAuth 2.1 with PKCE and RFC 9728 metadata for account linking, SQLite for per-household state, and a ui:// resource for the MCP Apps view. The Alexa+ add-on developer tools are partner-only, so the demo front end is a real MCP client and MCP Apps host in the browser (OAuth, Streamable HTTP with SSE, sandboxed iframe, postMessage protocol). Claude on Amazon Bedrock (Converse API with tool use) can drive it as the brain; without AWS credentials a small offline router runs the same loop. Purchasing sits behind a single StoreAdapter interface, the seam where Amazon's real ordering APIs would plug in. An Agent Skill in the repo teaches an assistant the plan, read back, confirm discipline.

## Challenges
- **Retitled listings** split one product into two forecast series and tanked confidence. Merging by ASIN, with a title-overlap fallback, fixed it.
- **Recall false positives.** A bare "12" from "12 Triple Rolls" was being read as a model number. Model tokens now need letters plus digits, or four or more digits.
- **A silent failure inside the iframe.** A single quote typo in the view script made the card render blank with no error. I now compile the view script in the test suite.
- **No Alexa+ tooling** meant writing my own MCP client and MCP Apps host from the specs.
- **Money needs more than a confirm button:** idempotency keys, a proposal expiry, and undo.

## What I learned
Honest uncertainty beats false precision, both in forecasts and in recall matching. An agent that can spend money needs a protocol-level gate, not a prompt-level promise. MCP Apps make tool results feel like a product instead of a transcript.

## What's next
Multi-tenant storage, more regional recall feeds beyond the U.S. CPSC, and plugging the StoreAdapter into a real ordering API. These are not built yet.

## Honest limits
The storefront is simulated, the sample orders are synthetic, and there is no real Alexa+ device. The recall data is real. 20 automated tests run end to end through the official MCP SDK client, including the OAuth flow and idempotent ordering.

# Demo video script (target 2:30, hard limit 3:00)

Record the browser at 1440x900 with the MCP wire drawer closed until the last scene. Use a real voice-over; do not use
copyrighted music. Judges may stop at 3:00, so the hook and the safety gate come first.

Setup: `npm run sample && npm start`; open http://localhost:3939 in a fresh profile (so you start unlinked).

| Time | On screen | Say |
|---|---|---|
| 0:00-0:15 | Cobalt screen: "Hi, I'm Alexa+... link Hearth to your account." | "Alexa+ forgets your household between conversations. Hearth is an MCP server that remembers what you run out of, checks your appliances for recalls, and never orders without a yes." |
| 0:15-0:35 | Click Link, consent page, Allow; header shows "Linked · hearth · MCP 2025-11-25". Open MCP wire for 3 seconds to show initialize | "That's a real OAuth 2.1 and PKCE account link, then MCP 2025-11-25 over Streamable HTTP." |
| 0:35-0:55 | Load sample order history; spoken line: imported 190, ignored 7 duplicates... | "The export is deliberately messy: mixed dates, duplicates, cancellations, retitled listings. Hearth cleans it and tells me what it did." |
| 0:55-1:25 | Ask "What are we running low on?" Receipt prints. Point at a range bar | "Each item has a likely window, not a fake date. Toothpaste is overdue; dog food runs out today." |
| 1:25-1:55 | Ask "Any recalls on what we own?" Recall slip prints; zoom on the evidence list and the stamp | "It matches my pressure cooker to a real CPSC recall on brand, type and model number OP302, and shows why. The blender is only 'possible' because I bought it after the recall date." |
| 1:55-2:25 | Ask "Plan a restock under $60". Plan prints with struck-through items. Press Place order. Receipt + barcode appear | "It plans within budget and tells me what it left out. Nothing is bought until I press this. The card calls confirm_restock back over MCP." |
| 2:25-2:40 | Press Cancel order; barcode voids. Open MCP wire briefly | "Ten-minute undo, idempotent retries, full audit log." |
| 2:40-2:55 | Terminal: `npm test` ending in 20 passing. Show `src/agent.ts` Bedrock call for 3 seconds | "20 end-to-end tests through the official MCP SDK. Claude on Amazon Bedrock can drive it. Open source, MIT." |

Do not show: real credentials, real Amazon trademarks beyond the word "Alexa+" used descriptively, any real orders.

# Demo video script (target 2:30, hard limit 3:00)

Record the browser at 1440x900 with the MCP wire drawer closed until the last scene. Use a real voice-over; do not use
copyrighted music. Judges may stop at 3:00, so the hook and the safety gate come first.

Setup: `npm run sample && npm start`; open http://localhost:3939 in a fresh profile (so you start unlinked).

| Time | On screen | Say |
|---|---|---|
| 0:00-0:15 | Cobalt screen: "Hi, I'm Alexa+... link Hearth to your account." | "Recalls get published, but owners are not reliably reached, and agents that spend money need a safety layer. Hearth is an MCP server that does both for Alexa+." |
| 0:15-0:30 | Click Link, consent page, Allow; header shows "Linked · MCP 2025-11-25". Open MCP wire for 3 seconds | "A real OAuth 2.1 and PKCE account link, then MCP 2025-11-25 over Streamable HTTP." |
| 0:30-0:45 | Load sample order history; spoken line: imported 190, ignored 7 duplicates... | "A deliberately messy export: mixed dates, duplicates, cancellations, retitled listings. Hearth cleans it and says what it did." |
| 0:45-1:10 | Ask "What are we running low on?" Receipt prints. Point at a range bar | "Each item has a likely window, not a fake date. Toothpaste is overdue; dog food runs out today." |
| 1:10-1:35 | Ask "Any recalls on what we own?" Recall slip prints; zoom on the evidence list and the stamp | "It matches my pressure cooker to a real CPSC recall on brand, type and model number OP302, and shows why. The blender is only 'possible' because I bought it after the recall date." |
| 1:35-2:00 | Ask "Plan a restock under $60". Plan prints with struck-through items. Press Place order. Receipt and barcode appear | "It plans within budget and says what it left out. Nothing is bought until I press this; the card calls confirm_restock back over MCP." |
| 2:00-2:25 | Terminal beside the browser: run `HEARTH_ADMIN_TOKEN=... npm run demo:recall -- Foodi` (server started with the same token); the idle simulator shows the red NEW RECALL banner and speaks | "Now the part that matters. A recall is published. Hearth finds every owner and pushes it to the open Alexa+ session over an MCP subscription, with nobody asking." |
| 2:25-2:40 | Press Cancel order on the receipt; barcode voids. Open MCP wire briefly | "Ten-minute undo, idempotent retries, spend ceilings, and a hash-chained audit log." |
| 2:40-2:55 | Terminal: `npm test` ending in 95 passing | "Ninety-five automated tests through the official MCP SDK, including an attack suite. Open source, MIT." |

Optional, only once `npm run bedrock:check` has really passed: add "Claude on Amazon Bedrock can drive it" and show the header reading
"Claude on Amazon Bedrock". Until then do not claim a live Bedrock run; say "it includes a Bedrock integration".

Do not show: real credentials, real Amazon trademarks beyond the word "Alexa+" used descriptively, any real orders.

## Dry run (measured on the live app, 2026-10-21)
App time per step, from sending the question to the end of the spoken reply: load sample history 1.4 s, "running low" 1.9 s,
recalls 2.2 s, plan 1.7 s, place order 1.0 s, undo 0.8 s, activity log 0.7 s; account linking about 2 s; operator command to
on-screen alert 0.5 s. Total app time for the whole script is roughly 12 s, so the video length is set by narration, not the app.
Also exercised live: "Forget my data" erased the household, revoked the token and returned the app to the unlinked screen.

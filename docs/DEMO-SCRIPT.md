# Demo video script (about 2:50, hard limit 3:00)

> A finished video made from this script (live Claude on Bedrock, neural Kokoro voices) is produced by `npm run demo:video`; its narration is in [demo/NARRATION.md](demo/NARRATION.md) if you would rather record your own voice.

`npm run demo:video` records at 1920x1080 (JPEG screencast, H.264 CRF 17); allow about 10 GB of free disk while it runs (it removes its frames afterwards). If you record by hand, use the same size with the MCP wire drawer closed until the link scene. Use a real voice-over; do not use
copyrighted music. Judges may stop at 3:00, so the hook and the safety gate come first.

Setup: `npm run sample && npm start`; open http://localhost:3939 in a fresh profile (so you start unlinked).

The scenes below are exactly what the recorder drives (see [scripts/make-demo-video.mjs](../scripts/make-demo-video.mjs)); silent waits for the model are cut, so times are approximate.

| Approx. | On screen | Say (see [demo/NARRATION.md](demo/NARRATION.md)) |
|---|---|---|
| 0:00 | Unlinked cobalt screen | Recalls reach few owners; an assistant that spends money needs a safety standard; Hearth does both. |
| 0:12 | Link, consent page, Allow; open the MCP wire drawer | Real OAuth with PKCE, MCP over Streamable HTTP, every message visible. |
| 0:22 | Load the family sample (messy export) | Hearth cleans it and says what it did. |
| 0:28 | "What are we running low on?", then tap **Why this date** | A likely window, never a fake precise date; one tap shows the arithmetic. |
| 0:50 | "Any recalls on what we own?", then press a remedy button | Matched on brand and model number with evidence; the remedy tracker records what you did. |
| 1:15 | "Order me ten laptops" | Not a store: it only restocks what the household already buys. |
| 1:30 | "Plan a restock under sixty dollars"; the card shows a four-digit approval code; say "Confirm" plus the code | Plans first within a budget; the model never sees the code; only the spoken code places the order. |
| 2:00 | Open the **Safety ledger**, then **Cancel order** | Every action and how it was approved, in a hash-chained ledger; ten-minute undo. |
| 2:10 | Second session: operator replays the real Foodi recall; the red banner appears and speaks | A recall is published; Hearth pushes it to every owner's open session over an MCP subscription. |
| 2:30 | Load the pantry sample, tap the Spanish chip | Spanish and Hindi replies; import your own export in any currency. |
| 2:40 | "Measured, not claimed" slide, then the closing card | 85% of known recalls surfaced, zero false alerts, 16 red-team attacks and no order placed, `npm test` ending in 142 passing; open source, MIT. |

Bedrock has passed `npm run bedrock:check` and run live, so you may say "Claude on Amazon Bedrock can drive it" and show the header reading
"Claude on Amazon Bedrock". It needs a fresh short-term key exported in the same terminal shortly before recording (keys last at most 12 hours), and a
model call can fail momentarily, so record when it answers cleanly; the app then falls back to its offline router for that answer.

Do not show: real credentials, real Amazon trademarks beyond the word "Alexa+" used descriptively, any real orders.

## Dry run (measured on the live app, 2026-10-21)
App time per step, from sending the question to the end of the spoken reply: load sample history 1.4 s, "running low" 1.9 s,
recalls 2.2 s, plan 1.7 s, place order 1.0 s, undo 0.8 s, activity log 0.7 s; account linking about 2 s; operator command to
on-screen alert 0.5 s. Total app time for the whole script is roughly 12 s, so the video length is set by narration, not the app.
Also exercised live: "Forget my data" erased the household, revoked the token and returned the app to the unlinked screen.

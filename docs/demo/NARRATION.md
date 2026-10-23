# Demo narration

`hearth-demo.mp4` was recorded at 1920x1080 by `npm run demo:video` (see [scripts/make-demo-video.mjs](../../scripts/make-demo-video.mjs)): it drives the real app, narrates
with a neural voice (open-source Kokoro, run locally by `scripts/tts-server.py`; set `HEARTH_TTS_DIR` to the folder holding its venv and model files, otherwise it falls back to macOS voices), and voices Alexa's actual replies in a second voice (and in Spanish for the Spanish reply). Waits for the model longer than about two seconds are compressed out of the final cut. The screen is real, including live Claude on Amazon Bedrock answers;
only the voices are synthetic.

To record your own voice instead, play the video silently, read the lines below at the marked moments, and export under 3:00.

| Moment | Line |
|---|---|
| Opening, unlinked screen | Recalls are published, but owners are rarely reached. And an assistant that can spend your money has no safety standard. Hearth is an Alexa Plus add-on that fixes both. |
| Linking, then the MCP wire drawer | A real OAuth account link with PKCE, then MCP over streamable HTTP. Every message is visible here. |
| Loading the family sample | A household with a baby, loaded from a messy order export. Hearth cleans it and says what it did. |
| "What are we running low on?", then Why this date | Now I just ask. Every item gets a likely window, never a fake precise date, and one tap shows the arithmetic. |
| "Any recalls on what we own?", then a remedy button | It checks everything the household owns against real recall notices from the US and Canada, by brand and model number, shows its evidence, and tracks what you did about it. |
| "Order me ten laptops" | Hearth is not a store. It only restocks what a household already buys. |
| "Plan a restock under sixty dollars" | When it restocks, it plans first, within a budget. The card shows a four digit approval code that the model never sees. |
| Saying "Confirm" and the code | I say the code aloud, and only then is the order placed, capped by limits the model cannot change. |
| Safety ledger, then Cancel order | Everything lands in a tamper evident safety ledger, and there is a ten minute undo. |
| The pushed recall alert | Now the part that matters. A recall is published. Hearth finds every owner and pushes it to their open Alexa Plus session over an MCP subscription. |
| Pantry sample, then Spanish | It speaks Spanish and Hindi too, and imports your own export in any currency. |
| "Measured, not claimed" slide | Measured, not claimed. Eighty five percent of known recalls surfaced, zero false alerts, sixteen red team attacks and no order placed, one hundred forty two tests. |
| Closing card | Hearth. Recall alerts and safe reordering for Alexa Plus. Open source, MIT. |

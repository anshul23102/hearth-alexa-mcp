# Demo narration

`hearth-demo.mp4` was recorded by `npm run demo:video` (see [scripts/make-demo-video.mjs](../../scripts/make-demo-video.mjs)): it drives the real app, narrates
with a neural voice (open-source Kokoro, run locally by `scripts/tts-server.py`; set `HEARTH_TTS_DIR` to the folder holding its venv and model files, otherwise it falls back to macOS voices), and voices Alexa's actual replies in a second voice. Waits for the model longer than about two seconds are compressed out of the final cut. The screen is real, including live Claude on Amazon Bedrock answers;
only the voices are synthetic.

To record your own voice instead, play the video silently, read the lines below at the marked moments, and export under 3:00.

| Moment | Line |
|---|---|
| Opening, unlinked screen | Recalls are published, but owners are rarely reached. And an assistant that can spend your money has no safety standard. Hearth is an Alexa Plus add-on that fixes both. |
| Linking, then the MCP wire drawer | A real OAuth account link with PKCE, then MCP over Streamable HTTP. Every message is visible here. |
| Loading the family sample | A household with a baby, loaded from a messy order export. Hearth cleans it and says what it did. |
| "What are we running low on?" | Now I just ask. Hearth learned this household's pace from its purchases, so every item gets a likely window, never a fake precise date. |
| "Any recalls on what we own?" | It checks everything the household owns against real recall notices from the US and Canada, by brand, product type and model number, and shows its evidence. |
| "Order me ten laptops" | Hearth is not a store. It only restocks what a household already buys. |
| "Plan a restock under sixty dollars" | When it restocks, it plans first, within a budget. Nothing is bought until I confirm. |
| Pressing Place order | Confirm calls back over MCP. Orders are idempotent, capped by limits the model cannot change, and audited. |
| Pressing Cancel order | And there is a ten minute undo. |
| The pushed recall alert | Now the part that matters. A recall is published. Hearth finds every owner and pushes it to their open Alexa Plus session over an MCP subscription. |
| India sample, then Spanish | It handles other countries too: rupees, day-first dates. Or load your own export. And it speaks Spanish, Hindi and English. |
| "Measured, not claimed" slide | Measured, not claimed. Eighty-five percent of known recalls surfaced, zero false alerts on unrelated products, ninety-seven tests, seventeen security findings fixed. |
| Closing card | Hearth. Recall alerts and safe reordering for Alexa Plus. Open source, MIT. |

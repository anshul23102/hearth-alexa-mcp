# YouTube upload package

Everything to paste into YouTube for `docs/demo/hearth-demo.mp4`, then into Devpost.
Chapter timestamps below were measured from the final video (accurate to a few seconds).

## Settings

| Field | Value |
|---|---|
| Visibility | **Public** (Devpost judges need to open it without signing in) |
| Category | Science & Technology |
| Audience | **No, it's not made for kids** |
| Language | English |
| Video language / captions | English; upload `docs/demo/hearth-demo.srt` if it exists, otherwise let YouTube auto-generate and skim for "Hearth", "MCP", "OAuth", "PKCE" |
| Thumbnail | `docs/gallery/thumbnail.png` |
| Comments | On |
| Altered / synthetic content | **Yes** for the voices: the narration and Alexa's replies are synthetic neural voices (see note in the description) |
| Licence | Standard YouTube licence |

## Title (70 characters or fewer)

```
Hearth: Alexa+ recall alerts and safe reordering (MCP demo)
```

(59 characters.)

## Description

```
Hearth is an Alexa+ add-on, built as an MCP server, that tells a household the day a product they own is recalled, and never spends their money without an explicit, undoable yes.

Built for the Amazon "Build, Ship, Shape" Developer Hackathon, Alexa+ track (with the AWS Builder mini-challenge: Claude on Amazon Bedrock).

WHAT THE VIDEO SHOWS
Everything on screen is the real app. Waits for the model longer than about two seconds were cut.
- The problem: recalls are published but owners are rarely reached, and an assistant that can spend money has no safety standard
- Real OAuth 2.1 + PKCE account linking, then MCP 2025-11-25 over Streamable HTTP, with every JSON-RPC message visible
- A deliberately messy order export (mixed date formats, duplicates, cancellations, retitled listings) cleaned and explained
- Forecast: a likely window and a confidence for each staple, never a fake-precise date, with "Why this date" showing the arithmetic
- Recall matching against real CPSC and Health Canada notices by brand, product type and model number, with evidence, plus a remedy tracker that keeps asking until you have dealt with it
- Hearth is not a store: "Order me ten laptops" is refused
- Safe reordering: a plan within a budget, a four-digit approval code shown only on the card (the model never sees it), voice approval with that code, operator-set spend limits, a hash-chained safety ledger and a ten-minute undo
- A recall published live is pushed to every owner's open Alexa+ session over an MCP resource subscription
- Replies in Spanish and Hindi, and import of your own export in any currency
- Measured, not claimed: 85% of known recalls surfaced, zero false alerts on unrelated products, 16 red-team attacks with no order placed, 142 automated tests

CHAPTERS
0:00 The problem and what Hearth is
0:11 Real OAuth 2.1 + PKCE account linking and the MCP wire
0:21 A messy household order export
0:28 Forecast: a likely window, never a fake date
0:44 Recalls matched by brand and model, plus the remedy tracker
1:09 Hearth is not a store
1:22 Safe reordering: approval code by voice, safety ledger, undo
1:40 A new recall pushed to every owner, then Spanish and Hindi
2:12 Measured, not claimed

HONEST NOTES
- Alexa+ add-on tooling is partner-only, so there is no real Alexa device in this video. A real MCP client (OAuth + PKCE, Streamable HTTP, MCP Apps host) stands in for it, which the hackathon FAQ allows.
- The storefront is a simulated adapter: no real purchases happen. An opt-in Amazon "Add to Cart" handoff exists but was not used here.
- The sample households are synthetic. The recall data is real.
- The narration and Alexa's replies are synthetic neural voices (open-source Kokoro, run locally), not a human recording. Claude on Amazon Bedrock answered live.

CODE AND DOCS (open source, MIT)
Repo: https://github.com/anshul23102/hearth-alexa-mcp
For judges: https://github.com/anshul23102/hearth-alexa-mcp/blob/main/JUDGING.md
Security: https://github.com/anshul23102/hearth-alexa-mcp/blob/main/SECURITY.md
Red team: https://github.com/anshul23102/hearth-alexa-mcp/blob/main/docs/REDTEAM.md

#Alexa #MCP #ModelContextProtocol #AmazonBedrock #ProductRecalls #Hackathon
```

Chapters block to substitute for `0:00 The problem and what Hearth is
0:11 Real OAuth 2.1 + PKCE account linking and the MCP wire
0:21 A messy household order export
0:28 Forecast: a likely window, never a fake date
0:44 Recalls matched by brand and model, plus the remedy tracker
1:09 Hearth is not a store
1:22 Safe reordering: approval code by voice, safety ledger, undo
1:40 A new recall pushed to every owner, then Spanish and Hindi
2:12 Measured, not claimed` (YouTube needs at least three, the first at `0:00`, each 10 seconds or longer):

```
0:00 The problem and what Hearth is
0:11 Real OAuth 2.1 + PKCE account linking and the MCP wire
0:21 A messy household order export
0:28 Forecast: a likely window, never a fake date
0:44 Recalls matched by brand and model, plus the remedy tracker
1:09 Hearth is not a store
1:22 Safe reordering: approval code by voice, safety ledger, undo
1:40 A new recall pushed to every owner, then Spanish and Hindi
2:12 Measured, not claimed
```

These match the scenes marked in `scripts/make-demo-video.mjs` (1 to 10). The closing title card is part of scene 10.

## Tags (under 500 characters)

```
Hearth, Alexa+, Alexa Plus, MCP, Model Context Protocol, MCP server, OAuth 2.1, PKCE, Amazon Bedrock, Claude, product recalls, CPSC recall, Health Canada recall, safe reordering, AI agent safety, human in the loop, Build Ship Shape, Amazon hackathon, Devpost, open source, TypeScript
```

(about 290 characters.)

## Pinned comment

```
Source, docs and a one-command run: https://github.com/anshul23102/hearth-alexa-mcp
Judges: start with JUDGING.md. The Alexa+ device is simulated by a real MCP client, the store is simulated, the recall data is real, and the voices in this video are synthetic. Questions about the approval-code design or the red-team results are welcome.
```

## Upload checklist

1. Check the video: 1080p, under 3:00, narration audible, no dead air.
2. Upload `docs/demo/hearth-demo.mp4`; title as above; paste the description with `0:00 The problem and what Hearth is
0:11 Real OAuth 2.1 + PKCE account linking and the MCP wire
0:21 A messy household order export
0:28 Forecast: a likely window, never a fake date
0:44 Recalls matched by brand and model, plus the remedy tracker
1:09 Hearth is not a store
1:22 Safe reordering: approval code by voice, safety ledger, undo
1:40 A new recall pushed to every owner, then Spanish and Hindi
2:12 Measured, not claimed` replaced by the chapters block (real timestamps).
3. Thumbnail, audience, category, language, synthetic-content setting as in the table.
4. Visibility **Public** (not Unlisted, not Private), then publish.
5. Open the link in a private/incognito window to confirm it plays without signing in; confirm the chapters appear on the timeline.
6. Post and pin the comment above.

## Devpost: paste the link and update fields

You press Submit yourself; nothing here submits for you.

1. Copy the public YouTube URL (`https://www.youtube.com/watch?v=...`).
2. Devpost project edit page, "Video demo link": paste it. The field is required; the page cannot be saved without it.
3. Save, wait for it to finish, then reload the edit page and confirm the link persisted.

Other fields to check or update:

- **Video demo link**: the new YouTube URL (required).
- **Image gallery**: the gallery images were regenerated tonight (`docs/gallery/*.png`), so re-upload only if you want the new versions on Devpost. Upload new images one at a time, delete the old ones, keep each caption at about 110 characters or fewer, save, wait, then verify by reloading.
- **Story ("About the project") and Testing instructions**: both should say **142 automated tests**. Confirm they do (they were updated earlier to 142).
- **India / rupee wording**: the India sample household was replaced by a US one. Remove any mention of "India", "rupees", "₹" or "day-first dates" from the story, testing instructions and image captions. The product still imports other currencies and date orders; say that generically if it is mentioned at all.
- **Built with / links**: the repo link `https://github.com/anshul23102/hearth-alexa-mcp` is public and MIT-licensed; nothing to add for reviewers.
- **Before pressing Submit**: preview the project page, confirm the video plays, and submit before Fri Oct 23 2026 12:00 PM PT (Oct 24 00:30 IST).

# Hearth: recall alerts and safe reordering for Alexa+

**In one sentence:** Hearth is an Alexa+ (MCP) add-on that tells a household *the day a product they own is recalled*, and
that never spends their money without an explicit, undoable yes.

| You are | Start here |
|---|---|
| A judge | [JUDGING.md](JUDGING.md): the four criteria, each with where to see the evidence (3 minutes) |
| Running it | [Run it](#run-it) below: `npm install && npm start` |
| Checking security | [SECURITY.md](SECURITY.md): 16 findings fixed, each with a test |


**The problem.** Recalls are published, but owners are not reliably reached: CPSC's own FY2025 report puts the correction rate across consumer
product recalls at 44.55%, and regulators are now ordering marketplaces to notify buyers directly. Separately, Alexa+ add-ons will
be able to spend customers' money, and there is no standard safety pattern for that. Hearth is a reference implementation of both
answers, built as a self-hosted **MCP server** (spec **2025-11-25**, **Streamable HTTP**, OAuth 2.1 + PKCE) for Alexa+.
The evidence, and what is *not* claimed, are in [docs/PROBLEM.md](docs/PROBLEM.md).

- **Proactive: the day a recall is published, its owners are told.** A background sync spots *new* notices, finds every household that owns the product through a brand index (1,250 owners of one product among 5,000 households in 37 ms), stores an alert, and pushes `notifications/resources/updated` over MCP to those households' open sessions. This is the "notify purchasers on publication" obligation regulators are putting on marketplaces. `npm run demo:recall` replays a real notice to show it live.
- **Owner-level recall matching across regulators.** Syncs the full public feeds (U.S. CPSC and Health Canada, **10,505 real notices**)
  into a local index and matches each household's appliances on brand, product type and model number, with the evidence.
  Measured on 1,669 cases built from real notices: **85.4%** of recalls surfaced, **0%** false alerts on unrelated products
  of the same brand, **2.1%** false "likely" on a wrong model. A match is `likely` only with a model-number hit.
- **Learns from messy global data.** Imports an order-history CSV the way real exports arrive: mixed date formats, many currencies
  (USD, GBP, EUR, INR, JPY... held in the right minor unit), duplicate rows, cancellations, missing quantities, retitled products
  (merged by ASIN, then title overlap). Streams files of hundreds of thousands of rows on a worker thread.
- **Forecasts with error bars.** Median days-per-unit across purchase gaps (robust to stock-ups), reported as a likely window
  and a confidence, never a fake-precise date.
- **A safety layer for agent purchases.** `plan_restock` only proposes. `confirm_restock` requires an explicit yes (MCP
  elicitation when the client supports it), is idempotent, has operator-set per-order and daily ceilings the model cannot
  change, a 10-minute `undo_restock`, and an audit log. The erase tool is hidden from the model.
- **Speaks the household's language.** Spoken replies in English, Spanish and Hindi, locale-correct money, per-household
  region and language preferences that persist across sessions.
- **Shows, not just tells.** Results render as a thermal-receipt card through an **MCP Apps** view
  (`ui://hearth/runway`) with working Place order / Cancel order buttons that call tools back over MCP.

Numbers are in [docs/SCALE.md](docs/SCALE.md); the security review is [SECURITY.md](SECURITY.md).

> The Alexa+ add-on developer tools are partner-only, so there is no real Alexa+ device here. The web page in
> `web/` is a **real MCP client** (OAuth + PKCE, Streamable HTTP/SSE, MCP Apps host) standing in for it, which
> the hackathon FAQ explicitly allows. The storefront is a **simulated** `StoreAdapter`; no real purchases occur.
> The three sample households in `data/` (`sample-orders.csv` US home, `sample-family.csv` family with a baby, `sample-india.csv` INR with day-first dates) are **synthetic**. The recall data is **real** (CPSC and Health Canada). You can also import your own Amazon export from the page.

## Run it

Requires Node 22.16+ (uses the built-in `node:sqlite`, including its online `backup`).

```bash
npm install
npm run sample     # (optional) regenerate the synthetic order export, dated relative to today
npm start          # http://localhost:3939  (MCP endpoint: /mcp)
```

Open http://localhost:3939, click **Link Hearth to Alexa+** (a real OAuth/PKCE flow), **Load sample order
history**, then ask: *what are we running low on?*, *any recalls on what we own?*, *plan a restock under $60*,
then press **Place order** on the card and **Cancel order**. Open **MCP wire** at the bottom to watch every
JSON-RPC message.

### Use it from any MCP client

```bash
HEARTH_AUTH=off npm start
claude mcp add --transport http hearth http://localhost:3939/mcp
```

### Optional: Claude on Amazon Bedrock as the brain

With AWS credentials in the environment (or `HEARTH_AGENT=bedrock`; verified live with Claude Haiku 4.5, see [docs/BEDROCK.md](docs/BEDROCK.md)), the simulator's reasoning runs on Claude
through the Bedrock **Converse API** with tool use (`src/agent.ts`). The browser still executes every tool call
as the MCP client. Without credentials it uses a small deterministic offline router, so judges can run
everything with no AWS account. Configure `AWS_REGION` and `BEDROCK_MODEL_ID` (see `.env.example`). To stay inside a free plan, model calls are capped per day (`HEARTH_BEDROCK_DAILY_CALLS`, default 150); past the cap the simulator falls back to the offline router. Check your setup with `npm run bedrock:check`; if your account cannot use a model, `npm run bedrock:probe` tries a short list of cheap ones and says which work.

## Tools

| Tool | What it does | Annotations |
|---|---|---|
| `import_order_history` | Clean and load a CSV export; re-import is a no-op | idempotent |
| `household_runway` | Forecast per item with ± window and confidence | read-only, UI |
| `recall_alerts` | Recalls published since the household last looked that match something they own (push + pull) | UI |
| `check_recalls` | Match owned durables to the local U.S. + Canada recall index, with evidence | read-only, UI |
| `plan_restock` | Propose an order within budget (household currency); buys nothing | UI |
| `confirm_restock` | Place a planned order after explicit approval | destructive, idempotent |
| `undo_restock` | Cancel within 10 minutes | destructive, idempotent |
| `remember_preference` | Persist budget, skip-item, language (en/es/hi), recall regions (US/CA) | idempotent |
| `delete_household_data` | Erase everything held for the household (app-only, hidden from the model) | destructive |
| `activity_log` | Transparent history of what Hearth did | read-only |

An **Agent Skill** teaching an assistant the plan → read back → confirm discipline is in
[`skill/hearth/SKILL.md`](skill/hearth/SKILL.md).

## Architecture

```
 browser (web/)                         server (src/)                         outside world
 ┌──────────────────────┐  Streamable   ┌──────────────────────────┐
 │ Alexa+ simulator     │──── HTTP ────▶│ MCP server (server.ts)   │──▶ recall index (CPSC + Health Canada,
 │  · OAuth/PKCE client │◀── JSON/SSE ──│  tools, ui:// resource   │    synced in background, fixture fallback)
 │  · MCP client (mcp.js)│              │ ingest → forecast → recalls (ask)
 │  · alert listener    │◀── push ──────│ recall sync → owner lookup → alerts → hub
 │  · MCP Apps host     │              │ actions: propose/confirm/undo ──▶ StoreAdapter (simulated)
 │    (sandboxed iframe)│              │ SQLite (node:sqlite): orders, recalls, alerts, proposals, audit, prefs, oauth
 │  · agent loop        │──/api/agent──▶│ agent.ts ──▶ Amazon Bedrock Converse (optional)
 └──────────────────────┘              └──────────────────────────┘
```

Key decisions: the browser is the MCP client (so judges see real protocol traffic); the LLM is server-side so AWS
credentials never reach the browser; the MCP App runs in an opaque-origin sandboxed iframe and can only call tools
the server marks visible to apps; purchasing sits behind one `StoreAdapter` interface, which is the seam where a
real ordering API plugs in.

## Tests

```bash
npm test         # 96 tests: unit, chaos, security, and end-to-end through the official MCP SDK client
npm run typecheck
```

The end-to-end suite starts the server and, with the SDK client, performs the full OAuth/PKCE flow (including a
wrong-verifier rejection), negotiates 2025-11-25, imports the messy CSV twice (second is a no-op), checks the
forecast, matches the **real** SharkNinja Foodi recall, enforces budget, refuses unconfirmed orders, proves retry
idempotency, undoes, and exercises elicitation approve/decline. The view's inline script is compiled in a test
because a typo there fails silently inside the iframe.

## Run it for real (production)

```bash
npm run build && npm run start:prod         # compiled JS, no tsx at runtime
# or: docker compose up --build              # non-root, read-only filesystem, healthcheck (compose file not built in CI here)
npm run backup -- backups/hearth-$(date +%F).db   # online, verified SQLite backup
```
Set `PUBLIC_URL` and `HEARTH_ALLOWED_HOSTS` behind a domain. `/healthz` and `/readyz` for probes; `/metrics` (Prometheus) turns on with
`HEARTH_METRICS_TOKEN`; JSON request logs go to stdout; SIGTERM drains and checkpoints the database. CI (`.github/workflows/ci.yml`)
runs typecheck, build, tests and `npm audit`. Demo the alert pipeline: start with `HEARTH_ADMIN_TOKEN=<24+ chars>` then
`HEARTH_ADMIN_TOKEN=<same> npm run demo:recall -- Foodi` while the simulator is open.

## Talking to it

The simulator holds a spoken conversation, the way Alexa does:
- **Mic button** opens a conversation; **"Say Alexa"** (hands-free) waits for the wake word. After every spoken reply the mic re-opens for a follow-up with no wake word, and silence ends the conversation.
- **Context** carries across turns. Long conversations are trimmed at turn boundaries (never splitting a tool call from its result), so they no longer fail after about ten questions. The offline router also handles follow-ups ("what about the dog food?", "thanks", "no thanks"); full open-ended context needs the Bedrock brain.
- **Languages:** pick English (US or India), हिन्दी or Español; the wake word works in Devanagari too. With the Bedrock brain the model answers in whatever language you speak; the offline router's sentences exist in English, Spanish and Hindi.
- **The voice** is your browser's own text-to-speech. Hearth ranks the installed voices and picks the warmest natural one per language (a downloaded Premium or Enhanced voice always wins; on a Mac add one under System Settings, Accessibility, Spoken Content, System voice, Manage voices). Amazon's real Alexa voice is not available to third-party apps, so this is not that voice.
- **Privacy:** recognition uses the browser's speech service (Chrome sends the audio to Google). Nothing listens until you press the mic or turn hands-free on, the mic is closed while Alexa speaks, and there is no always-on background listening by default.
- **Limits:** no barge-in (you cannot interrupt her mid-sentence); hands-free needs Chrome and a quiet room; wake-word detection is plain speech recognition, not a trained hotword model, so it can miss or false-trigger.

## Scale and accuracy

```bash
npm run bench -- 5000 200     # 676k orders, 5,000 households: import, forecast and recall latency
npm run eval       # precision/recall of recall matching on real notices
```
`POST /api/import` (Bearer token, `Content-Type: text/csv`) streams a large export on a worker thread. A 500k-row, 43.5 MB
upload took 12.4 s while concurrent requests stayed at p99 13 ms. Full tables and caveats: [docs/SCALE.md](docs/SCALE.md).

## Honest limitations

- No real Alexa+ device or add-on certification (tooling is partner-only); no real storefront (`StoreAdapter` is simulated).
- Bedrock was exercised live once (Claude Haiku 4.5, one account, one session of 36 calls; [docs/BEDROCK.md](docs/BEDROCK.md)); CI runs it only against a stand-in server.
- OAuth is a minimal authorization server for demonstrating account linking (tokens hashed in SQLite, rotation, PKCE).
  Its consent step does not authenticate a person; production delegates to the household's real identity provider.
- One node and SQLite. Scaling out means Postgres (the data access is plain SQL in `src/`), a shared rate-limit store, and a pub/sub for the alert push; none of that is built.
- Every grant creates its own household; isolation is by `household` key in every query and is tested, but not at hostile scale.
- The offline voice router understands English only (it is a small intent matcher); with the Bedrock brain Claude can interpret other languages, which is untested here. Replies are in English, Spanish or Hindi; the Spanish and Hindi strings need native review.
- The synthetic households prove throughput, not forecast accuracy on real purchases. Spanish and Hindi strings should be reviewed by native speakers.
- Recall matching is heuristic by design (it says `possible` when unsure). It is a prompt to check the product
  label, not a safety guarantee.
- Order exports other than the column shapes in `src/ingest.ts` will need header synonyms added.

## Layout

`src/` server (ingest, forecast, recall index, matcher, actions, MCP tools, OAuth, security, Bedrock) · `web/` simulator and MCP Apps host ·
`src/view.html` the MCP App view · `skill/` Agent Skill · `test/` · `docs/` submission notes · `PRODUCT.md`, `DESIGN.md`.

MIT licensed.

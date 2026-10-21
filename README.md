# Hearth: household memory for Alexa+

Hearth is a self-hosted **MCP server** (spec **2025-11-25**, **Streamable HTTP**, OAuth 2.1 + PKCE) that gives
Alexa+ something it does not have today: a durable, honest memory of what a household buys and when it runs out.

- **Learns from messy data.** Imports an order-history CSV the way real exports arrive: mixed date formats,
  `$`/`USD` prices, duplicate rows, cancellations, missing quantities, and the same product retitled between
  orders. Retitled listings are merged by ASIN, then by title overlap.
- **Forecasts with error bars.** Median days-per-unit across purchase gaps (robust to stock-ups), reported as a
  likely window and a confidence, never a fake-precise date.
- **Checks what you own against live U.S. CPSC recalls.** Matches on brand, product type and model number and
  returns the evidence. `likely` needs a model-number hit; everything weaker is `possible`.
- **Acts safely.** `plan_restock` only proposes. `confirm_restock` requires an explicit yes (and uses MCP
  elicitation when the client supports it), is idempotent (a retry never orders twice), and every order has a
  10-minute `undo_restock`. Every action lands in an audit log.
- **Remembers across sessions.** Budget cap and "never reorder this" live in SQLite per household.
- **Shows, not just tells.** Tool results render as a thermal-receipt card through an **MCP Apps** view
  (`ui://hearth/runway`), including working Place order / Cancel order buttons that call tools back over MCP.

> The Alexa+ add-on developer tools are partner-only, so there is no real Alexa+ device here. The web page in
> `web/` is a **real MCP client** (OAuth + PKCE, Streamable HTTP/SSE, MCP Apps host) standing in for it, which
> the hackathon FAQ explicitly allows. The storefront is a **simulated** `StoreAdapter`; no real purchases occur.
> `data/sample-orders.csv` is **synthetic**. The recall data is **real** (CPSC).

## Run it

Requires Node 22.13+ (uses the built-in `node:sqlite`).

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

With AWS credentials in the environment (or `HEARTH_AGENT=bedrock`), the simulator's reasoning runs on Claude
through the Bedrock **Converse API** with tool use (`src/agent.ts`). The browser still executes every tool call
as the MCP client. Without credentials it uses a small deterministic offline router, so judges can run
everything with no AWS account. Configure `AWS_REGION` and `BEDROCK_MODEL_ID` (see `.env.example`).

## Tools

| Tool | What it does | Annotations |
|---|---|---|
| `import_order_history` | Clean and load a CSV export; re-import is a no-op | idempotent |
| `household_runway` | Forecast per item with ± window and confidence | read-only, UI |
| `check_recalls` | Match owned durables to live CPSC recalls with evidence | read-only, open-world, UI |
| `plan_restock` | Propose an order within budget; buys nothing | UI |
| `confirm_restock` | Place a planned order after explicit approval | destructive, idempotent |
| `undo_restock` | Cancel within 10 minutes | destructive, idempotent |
| `remember_preference` | Persist budget / skip-item across sessions | idempotent |
| `activity_log` | Transparent history of what Hearth did | read-only |

An **Agent Skill** teaching an assistant the plan → read back → confirm discipline is in
[`skill/hearth/SKILL.md`](skill/hearth/SKILL.md).

## Architecture

```
 browser (web/)                         server (src/)                         outside world
 ┌──────────────────────┐  Streamable   ┌──────────────────────────┐
 │ Alexa+ simulator     │──── HTTP ────▶│ MCP server (server.ts)   │──▶ CPSC recalls API (live; cached 24h,
 │  · OAuth/PKCE client │◀── JSON/SSE ──│  tools, ui:// resource   │    bundled fixture fallback)
 │  · MCP client (mcp.js)│              │ ingest → forecast → recalls
 │  · MCP Apps host     │              │ actions: propose/confirm/undo ──▶ StoreAdapter (simulated)
 │    (sandboxed iframe)│              │ SQLite (node:sqlite): orders, proposals, audit, prefs
 │  · agent loop        │──/api/agent──▶│ agent.ts ──▶ Amazon Bedrock Converse (optional)
 └──────────────────────┘              └──────────────────────────┘
```

Key decisions: the browser is the MCP client (so judges see real protocol traffic); the LLM is server-side so AWS
credentials never reach the browser; the MCP App runs in an opaque-origin sandboxed iframe and can only call tools
the server marks visible to apps; purchasing sits behind one `StoreAdapter` interface, which is the seam where a
real ordering API plugs in.

## Tests

```bash
npm test         # 20 tests: unit + end-to-end through the official MCP SDK client
npm run typecheck
```

The end-to-end suite starts the server and, with the SDK client, performs the full OAuth/PKCE flow (including a
wrong-verifier rejection), negotiates 2025-11-25, imports the messy CSV twice (second is a no-op), checks the
forecast, matches the **real** SharkNinja Foodi recall, enforces budget, refuses unconfirmed orders, proves retry
idempotency, undoes, and exercises elicitation approve/decline. The view's inline script is compiled in a test
because a typo there fails silently inside the iframe.

## Honest limitations

- No real Alexa+ device or add-on certification (tooling is partner-only); no real storefront (`StoreAdapter` is simulated).
- The Bedrock path is unit-tested against a stubbed client; run it with your own credentials to exercise it live.
- OAuth is a minimal in-memory authorization server for demonstrating account linking; tokens reset on restart.
  Production would delegate to the household's real identity provider.
- Single household per token (`demo`); multi-tenant isolation is by `household` key in every query but untested at scale.
- Recall matching is heuristic by design (it says `possible` when unsure). It is a prompt to check the product
  label, not a safety guarantee.
- Order exports other than the column shapes in `src/ingest.ts` will need header synonyms added.

## Layout

`src/` server (ingest, forecast, recalls, actions, MCP tools, OAuth, Bedrock) · `web/` simulator and MCP Apps host ·
`src/view.html` the MCP App view · `skill/` Agent Skill · `test/` · `docs/` submission notes · `PRODUCT.md`, `DESIGN.md`.

MIT licensed.

# Devpost submission pack

Everything to paste into the submission form. Items in **[YOU]** need a human; do not submit them as-is.

## Track and mini challenges
- Primary track: **Alexa+** (self-hosted MCP server, spec 2025-11-25, Streamable HTTP; Agent Skill included;
  simulated-experience front end that is a real MCP client).
- Mini challenges: **AWS Builder** (Amazon Bedrock Converse API, `src/agent.ts`) and **Open Source** (MIT repo).
  **[YOU]** Open Source requires "a new, additional open-source project or a contribution" plus the contribution URL.
  There is an open forum thread asking whether the primary repo itself counts; check the answer, or open a small
  PR to a public repo during the window and use that URL.

## Project name
Hearth: household memory for Alexa+

## Tagline
Alexa+ that remembers what your household runs out of, warns you about recalled appliances, and never orders without a yes.

## Text description
Alexa+ answers questions, but it forgets the household between them. Hearth is a self-hosted MCP server that gives it
durable memory of what a family buys and when it runs out, and the judgment to act on that safely.

**What it does.** Import an order-history export and Hearth cleans it the way real exports arrive: mixed date
formats, currency symbols, duplicate rows, cancellations, missing quantities and the same product retitled between
orders (merged by ASIN, then title overlap). It forecasts when each consumable runs out from the median
days-per-unit across purchase gaps, and reports a likely window and a confidence instead of false precision. It
matches the appliances you own against live U.S. CPSC recall notices on brand, product type and model number and
returns the evidence; only a model-number hit earns "likely". It proposes restocks within a budget you set once and
Hearth remembers. Nothing is bought until you say yes; the order is idempotent, undoable for ten minutes, and
audit-logged.

**How it works.** A TypeScript MCP server (official SDK, spec 2025-11-25, Streamable HTTP, OAuth 2.1 + PKCE with
RFC 9728 metadata) with eight annotated tools, SQLite state per household, an MCP Apps view (`ui://hearth/runway`)
that renders results as a thermal-receipt card with working Place order / Cancel buttons, and MCP elicitation for
approval. Since the Alexa+ add-on tools are partner-only, the demo front end is a real MCP client and MCP Apps host
in the browser, with an optional Claude-on-Amazon-Bedrock brain (Converse API with tool use). Purchasing sits behind
one `StoreAdapter` interface (simulated here), the seam where Amazon's ordering APIs would plug in.

**Why it matters.** Replenishment and recalls are things customers care about and nobody has time to track. The
pattern (plan, read back, confirm, undo, audit) is a reusable template for any Alexa+ add-on that spends money.

**Built during the window.** Entirely new; see git history. 20 automated tests run end to end through the official MCP
SDK client, including the OAuth flow and idempotent ordering.

**Honest limits.** Simulated storefront, synthetic sample orders, no real Alexa+ device. Recall data is real.

## Links **[YOU]**
- Repo: (public GitHub URL; MIT license visible in About)
- Video (YouTube/Vimeo, public, < 3 min): see `docs/DEMO-SCRIPT.md`

## Product feedback (required): written from what was actually used
**[YOU]** Edit to match your own experience before submitting; sections marked VERIFY were not exercised live here.

**MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32)**, used for the server, Streamable HTTP transport, tool
annotations, structured output, resources and elicitation; also the client in tests.
- Worked well: `McpServer.registerTool` with zod; protocol negotiation to 2025-11-25 worked first time; the same
  package's client made an honest end-to-end test trivial; elicitation round-trips cleanly.
- Needs work: wiring the transport into a plain `node:http` server with per-session transports takes boilerplate and
  `req.auth` typing is easy to trip over. Input-schema violations come back as tool errors (spec-correct) but this
  was easy to assume would throw.
- Onboarding: minutes. Would build again: yes.

**MCP Apps (ext-apps spec)**, used for the `ui://` card view and a hand-written host.
- Worked well: the postMessage JSON-RPC model is small and clear; tool `_meta.ui.visibility` is a good safety lever.
- Needs work: no reference host to test a view against, so I implemented the host from the spec; the Apps spec
  carries its own protocol version string (2026-01-26) alongside MCP's 2025-11-25, which is confusing at first. A
  minimal, copy-pasteable host would cut a day off adoption.
- Would build again: yes.

**Alexa+ add-on docs and developer tools**, docs read, tools **not** accessible (partner-only, per the FAQ).
- Needs work: the preview-only status is easy to miss on setup-guide pages (the FAQ itself says so), which wasted
  time deciding the track was feasible. The auth checklist I saw says unauthenticated requests should get a 401
  *without* a `WWW-Authenticate` header, while the MCP authorization spec relies on that header for discovery. VERIFY
  which a real Alexa+ client expects; Hearth returns the header.
- Would build again: yes, once self-serve access exists.

**U.S. CPSC Recall API** (not an Amazon tool, but central): free, no key, JSON, searchable by product name. Model
numbers appear only inside free-text descriptions, so matching is heuristic. Also: it returned an empty list for some
very large brands, so a cached snapshot fallback is needed for demos.

**Amazon Bedrock (Converse API)**: **[YOU] VERIFY.** The adapter (`src/agent.ts`) maps messages and tool use to
Converse and is unit-tested with a stub; fill in your real experience (model access approval, region/inference-profile
IDs, latency) after running it with credentials. Describe AWS usage here for the AWS Builder challenge.

**Devpost/hackathon resources**: Resources and FAQ pages were clear and the FAQ answered the hardest question (what
counts as an Alexa+ demo without device access) directly.

## Friction log (optional, up to +10% judging bonus). All items observed
1. **Task:** read submission requirements for repo visibility. **Expected:** one clear rule. **Actual:** the rules page
   includes a first-person line ("Make sure this repo is private, then add these GitHub users... so they can review my
   submission") beside the "public with license OR private shared" option; it reads like pasted form text and
   contradicts the public path. **Severity:** low. **Workaround:** followed the FAQ. **Suggestion:** reword to the
   conditional.
2. **Task:** decide whether an Alexa+ build is possible without device tooling. **Expected:** clear from the track
   description. **Actual:** only the FAQ states the Category SDK, MCP Toolkit, CLI and Web Simulator are partner-only.
   **Severity:** medium (time lost). **Workaround:** simulated-client path. **Suggestion:** put the gating notice at the
   top of the Alexa+ track description and every setup page.
3. **Task:** implement MCP auth for Alexa+. **Expected:** one authoritative checklist consistent with the MCP spec.
   **Actual:** docs summary says 401 without `WWW-Authenticate`; spec discovery needs it. **Severity:** medium.
   **Workaround:** return the header. **Suggestion:** state which is required and why. VERIFY against the live page.
4. **Task:** show an MCP App to judges. **Expected:** a reference host to test against. **Actual:** none; wrote one.
   **Severity:** medium. **Suggestion:** ship a minimal reference host and sandbox proxy.

## Feature requests (optional)
- Self-serve Alexa+ add-on sandbox for hackathon participants. Why: lets teams demo on real surfaces. **Critical**.
- A documented MCP-Apps card size/density guide for Echo Show. **Important**.
- Order-history export API for customers (with consent) as an MCP resource. **Important**.

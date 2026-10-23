# Security review

Scope: this repository (MCP server, OAuth server, simulator host, MCP App view). Method: manual code review of every
entry point, then an attack test for each finding (`test/security.test.ts`, run against a live server). This is a
self-audit, **not** a third-party penetration test.

## Assets and trust boundaries
- **Assets:** household order history (personal data), the ability to place orders, OAuth tokens, Bedrock spend.
- **Untrusted:** every HTTP caller, product titles in order files, recall-feed text, model output, the MCP App iframe.
- **Trusted:** the server process and its operator configuration.

## Findings and fixes
F1 to F11 came from the first pass; F12 to F17 from later passes after proactive alerts, bulk import and operations endpoints were added; F18 and F19 from a review of the consent path. Database files are created owner-only (`0600`).
| # | Severity | Finding (before) | Fix | Test |
|---|---|---|---|---|
| F1 | High | `/api/agent/step` (paid Bedrock call) was unauthenticated; anyone reaching the port could burn credits | Bearer auth, per-household rate limit, strict body validation and size caps | F1, agent validation |
| F2 | High | All linked users shared one household, so one customer's orders were visible to another | A fresh household per grant; every query scoped by household; sessions bound to the household that opened them | F2 |
| F3 | Medium | No Host/Origin validation, wildcard CORS on `/mcp` (DNS rebinding, cross-site calls) | Host allowlist (421), Origin allowlist (403), CORS only echoed to allowed origins | F3 (x2) |
| F4 | Medium | Consent had no CSRF protection and could be framed | Single-use server-side nonce, `Sec-Fetch-Site` check, `frame-ancestors 'none'`, mandatory S256 PKCE, exact redirect match | F4 |
| F5 | Medium | No rate limits; unbounded client registrations and sessions | Limiters on register/token/authorize/mcp/agent/import; client, session and pending-consent caps; idle session expiry | F5 |
| F6 | Medium | Tokens in plaintext memory, lost on restart; refresh tokens never rotated | SHA-256 hashed tokens in SQLite, 1 h access TTL, rotating refresh tokens with reuse detection that revokes the whole grant, RFC 7009 revoke, single-use codes, constant-time PKCE compare | F6 |
| F7 | Medium | A prompt-injected model could place an order of any size | Operator-set per-order and rolling 24 h ceilings the model cannot change; plan size cap; elicitation when the client supports it; undo; audit | F7 |
| F8 | Low | No CSP or security headers; one `innerHTML` with server text in the host | Hash-only CSP (the receipt view's script is allowed by SHA-256), nosniff, DENY framing, no-referrer; zero HTML sinks in host JS | F8, hygiene |
| F9 | Low | No way for a customer to erase their data | `delete_household_data`: hidden from the model (`visibility: app`), exact confirmation phrase, elicitation when available, revokes tokens | privacy |
| F11 | Low | The audit log was append-only by convention: a database editor could rewrite history unnoticed | SHA-256 hash chain per household (`seq`, `prev_hash`, `hash`, unique index); `activity_log` verifies it and says so if it fails; concurrent writers cannot fork it | F-audit (incl. race) |
| F12 | Medium | One authenticated household could open thousands of MCP sessions and push others' sessions out | Per-household session cap (default 20); past it, that household's own oldest session is closed | F5b |
| F13 | Medium | No limit on concurrent bulk imports, so many uploads could each start a worker thread | Global concurrency cap (default 3) with `503` and `Retry-After` | F5c |
| F14 | Medium | `HEARTH_AUTH=off` makes every caller one shared household and could be set by mistake on a real deployment | The server refuses to start with auth off when `NODE_ENV=production` or `PUBLIC_URL` is set | misconfiguration test |
| F15 | Low (privacy) | "Delete my data" did not remove recall alerts, which record what a household owns | Alerts are erased too; the test now checks *every* table with a `household` column, so a future table cannot be forgotten | privacy tests |
| F16 | Medium (coverage) | After one feed outage at startup the bundled 4-notice snapshot was treated as fresh for 24 h, silently disabling recall coverage | A snapshot or failed sync is retried every 10 minutes; only a live download is trusted for a day; a failing feed never shrinks a good index | outage-fallback test |
| F17 | Low | The static file server answered any HTTP method (PUT, TRACE) with the page | Only GET and HEAD are served; everything else gets 405 | method test |
| F18 | High | `confirm_restock` took a `userConfirmed` boolean, so a prompt-injected model could place an order by simply asserting the user agreed | Removed. The model's only route needs a 4-digit approval code issued to the plan card by an app-only tool and never given to the model; stored hashed; three wrong codes lock the plan, nine an hour pause voice approvals; the card's button uses a separate app-only tool; every order logs how consent was proven | approval tests; live red team |
| F19 | Medium | The simulator host offered every tool to the model, including ones marked app-only (the erase tool among them) | The host filters by tool visibility, and `/api/agent/step` strips the app-only tools again whatever the browser sends; a test pins the list against the server's metadata | e2e visibility test; approval router test |
| F10 | Low | Client registration accepted `javascript:`, `data:` and remote `http:` redirect URIs | https or loopback only, no fragments, at most 5 | F10 |

Also verified with tests: static server path traversal (7 encodings), SQL metacharacters in data and inputs, an
injection-style product title, no string-built SQL anywhere in `src/`, and no secrets in tracked files. `npm audit`: 0
known vulnerabilities at time of writing.

## Defenses by design (not bugs, but worth stating)
- **Propose, confirm, undo, audit.** `plan_restock` buys nothing. `confirm_restock` is idempotent and every order is undoable for 10 minutes.
- **Consent a model cannot forge.** There is no `userConfirmed` flag. The model's only route to an order is `confirm_restock` with a 4-digit **approval code that exists only on the on-screen plan card**: an app-only tool (`approval_code`) issues it to the card, it is stored as a salted SHA-256, it is never written into anything the model reads, and a person has to read it out. Three wrong codes lock the plan and nine in an hour pause voice approvals for the household. Clients that support MCP elicitation can use that instead (a prompt the client itself shows). The card's **Place order** button calls a second app-only tool, `approve_restock`: the press is the consent. Every confirmed order records which proof was used (`consent`: `code`, `app` or `elicitation`). Pinned by `test/approval.test.ts` and measured against a live model by `npm run redteam`.
- **Tool visibility.** The receipt card can call only `approval_code`, `approve_restock`, `undo_restock` and `delete_household_data`; the model is never offered the first, second or last (`/api/agent/step` strips them too).
- **Sandboxed view.** The MCP App runs in an opaque-origin iframe (`sandbox="allow-scripts"`), cannot read the host token, and only links to the two regulators' domains are openable.
- **Feed hygiene.** Recall text is stripped of control and bidi characters and length-capped; only https links to the indexed regulators reach the UI.

## Residual risks (honest)
1. **Approval codes depend on the host honouring tool visibility.** MCP's `visibility: ["app"]` is metadata for the host: a host that offered `approval_code` or `approve_restock` to a model would defeat the code (our simulator host and `/api/agent/step` both enforce it, and a test checks it). A model also cannot pass the code unless a person says it, so a deployment without a screen has no voice route: it should use elicitation or the platform's own voice-verified confirmation. Ceilings, undo and the audit log still bound the damage either way.
2. **Consent is a demo.** The consent page does not authenticate a person; production must delegate to the household's identity provider. Everything downstream (hashing, rotation, scoping) is unchanged.
3. **No encryption at rest, single node.** Order history sits in a SQLite file; use disk encryption or a managed database, and a shared store (Redis/DynamoDB) for rate limits behind a load balancer.
4. **Data egress to the model provider.** In Bedrock mode, product titles and tool results are sent to the model. Use a region and model access policy that match your data-residency rules.
5. **`style-src 'unsafe-inline'`** remains because the receipt view uses inline style attributes; scripts are hash-locked.
6. **The audit chain detects tampering, it does not prevent it.** Someone with write access can still rewrite the whole chain consistently, and the self-check alone would pass (`test/anchor.test.ts` shows exactly that). The Safety ledger now shows a fingerprint that the browser remembers for the session, so a rewrite after that point does not match; for lasting protection anchor the latest hash somewhere you trust (a log service, S3 object lock).
7. **Untested at hostile scale.** Rate limits are per node and in memory; there has been no load or fuzz campaign beyond the included tests.

## Supply chain
Dependabot (npm, GitHub Actions, Docker) and CodeQL with the `security-extended` query set run on the repository (`.github/`), `npm audit` runs in CI on production dependencies, and the lockfile is committed. These run on public repositories.

## Operations endpoints
- `GET /healthz` liveness, `GET /readyz` readiness (database answers and the recall index has data), both unauthenticated; `/readyz` returns only two aggregate counts (notices indexed, open sessions), never household data.
- `GET /metrics` Prometheus text; **404 unless `HEARTH_METRICS_TOKEN` (16+ chars) is set**, then bearer-protected, constant-time compared. Labels are route groups, tool names and outcomes only: no household ids, tokens or arguments (tested).
- `POST /api/admin/recalls/replay` **404 unless `HEARTH_ADMIN_TOKEN` (24+ chars) is set**; rate limited; replays a notice already in the index so the alert pipeline can be demonstrated. It cannot create notices.
- `/.well-known/security.txt` points to the private advisory form.
- Structured JSON request logs carry a request id, route group and status; never headers, tokens or bodies.

## Operator knobs
`HEARTH_MAX_ORDER`, `HEARTH_MAX_DAILY` (major units), `HEARTH_ALLOWED_HOSTS`, `HEARTH_ALLOWED_ORIGINS`, `HEARTH_TRUST_PROXY`,
`HEARTH_RATE_REGISTER|TOKEN|AUTHORIZE`, `HEARTH_BEDROCK_DAILY_CALLS` (hard daily cap on paid model calls), `HEARTH_ADMIN_TOKEN`, `HEARTH_METRICS_TOKEN`, `HEARTH_MAX_UPLOAD_MB`, `PUBLIC_URL`. Set `PUBLIC_URL` and `HEARTH_ALLOWED_HOSTS` when deploying behind a domain.

## Reporting
Open a private security advisory on the GitHub repository.

## Reporting a vulnerability
Please report privately through GitHub's [private vulnerability reporting](https://github.com/anshul23102/hearth-alexa-mcp/security/advisories/new) rather than a public issue. Include the request or input that triggers it and what you expected. This is a hackathon project maintained by one person, so there is no response-time guarantee, but reports are read and credited.

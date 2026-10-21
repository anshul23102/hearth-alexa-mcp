# Security review

Scope: this repository (MCP server, OAuth server, simulator host, MCP App view). Method: manual code review of every
entry point, then an attack test for each finding (`test/security.test.ts`, run against a live server). This is a
self-audit, **not** a third-party penetration test.

## Assets and trust boundaries
- **Assets:** household order history (personal data), the ability to place orders, OAuth tokens, Bedrock spend.
- **Untrusted:** every HTTP caller, product titles in order files, recall-feed text, model output, the MCP App iframe.
- **Trusted:** the server process and its operator configuration.

## Findings and fixes
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
| F10 | Low | Client registration accepted `javascript:`, `data:` and remote `http:` redirect URIs | https or loopback only, no fragments, at most 5 | F10 |

Also verified with tests: static server path traversal (7 encodings), SQL metacharacters in data and inputs, an
injection-style product title, no string-built SQL anywhere in `src/`, and no secrets in tracked files. `npm audit`: 0
known vulnerabilities at time of writing.

## Defenses by design (not bugs, but worth stating)
- **Propose, confirm, undo, audit.** `plan_restock` buys nothing. `confirm_restock` is idempotent and every order is undoable for 10 minutes.
- **Tool visibility.** The receipt card can call only `confirm_restock`, `undo_restock` and `delete_household_data`; the model is never offered the erase tool.
- **Sandboxed view.** The MCP App runs in an opaque-origin iframe (`sandbox="allow-scripts"`), cannot read the host token, and only links to the two regulators' domains are openable.
- **Feed hygiene.** Recall text is stripped of control and bidi characters and length-capped; only https links to the indexed regulators reach the UI.

## Residual risks (honest)
1. **The model can set `userConfirmed`.** A manipulated model could confirm a plan the user did not approve. Ceilings, undo, audit and elicitation limit the damage; they do not remove it. The real fix needs a user-presence signal from the Alexa+ platform (for example, a voice-verified confirmation token only the platform can mint). This is listed as a feature request.
2. **Consent is a demo.** The consent page does not authenticate a person; production must delegate to the household's identity provider. Everything downstream (hashing, rotation, scoping) is unchanged.
3. **No encryption at rest, single node.** Order history sits in a SQLite file; use disk encryption or a managed database, and a shared store (Redis/DynamoDB) for rate limits behind a load balancer.
4. **Data egress to the model provider.** In Bedrock mode, product titles and tool results are sent to the model. Use a region and model access policy that match your data-residency rules.
5. **`style-src 'unsafe-inline'`** remains because the receipt view uses inline style attributes; scripts are hash-locked.
6. **Audit log is not tamper-evident.** It is append-only by convention, not by construction.
7. **Untested at hostile scale.** Rate limits are per node and in memory; there has been no load or fuzz campaign beyond the included tests.

## Operator knobs
`HEARTH_MAX_ORDER`, `HEARTH_MAX_DAILY` (major units), `HEARTH_ALLOWED_HOSTS`, `HEARTH_ALLOWED_ORIGINS`, `HEARTH_TRUST_PROXY`,
`HEARTH_RATE_REGISTER|TOKEN|AUTHORIZE`, `HEARTH_BEDROCK_DAILY_CALLS` (hard daily cap on paid model calls), `HEARTH_MAX_UPLOAD_MB`, `PUBLIC_URL`. Set `PUBLIC_URL` and `HEARTH_ALLOWED_HOSTS` when deploying behind a domain.

## Reporting
Open a private security advisory on the GitHub repository.

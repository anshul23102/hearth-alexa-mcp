# For judges: Hearth in three minutes

**What it is.** An Alexa+ add-on (a self-hosted MCP server, spec 2025-11-25, Streamable HTTP) that does two things:

1. **Tells a household the day a product they own is recalled.** Real U.S. (CPSC) and Canadian (Health Canada) notices, matched to what the household actually bought.
2. **Never spends their money without an explicit, undoable yes.** When Alexa+ restocks things the household already buys, every order is planned, read back, confirmed and reversible.

Nothing else is in scope. Hearth is not a store and refuses to buy new products.

## Try it (2 minutes)

```bash
npm install && npm start      # Node 22.16+, no AWS account needed
```

Open http://localhost:3939 → **Link Hearth to Alexa+** → **Load sample order history** → ask *"any recalls on what we own?"*, *"plan a restock under $60"*, press **Place order**, then **Cancel order**.
To watch a recall arrive by push: set `HEARTH_ADMIN_TOKEN` (24+ characters) and run `npm run demo:recall -- Foodi`.

## The four criteria

### Tech Implementation: does it use the required tech, and is it well built?
| Claim | Where to see it |
|---|---|
| Real MCP server, spec 2025-11-25, Streamable HTTP | `src/server.ts`, `src/http.ts`; the **MCP wire** drawer in the page shows every JSON-RPC message |
| OAuth 2.1 + PKCE account linking (what Alexa+ uses) | `src/oauth.ts`; `test/e2e.test.ts` includes a wrong-verifier rejection |
| MCP features beyond tools: elicitation, resource subscriptions with push, MCP Apps UI, tool annotations | `src/server.ts`, `src/view.html`, `src/hub.ts` |
| Agent Skill as well as MCP | `skill/hearth/SKILL.md` |
| Claude on Amazon Bedrock (Converse API, tool use), live-verified | `src/agent.ts`, [docs/BEDROCK.md](docs/BEDROCK.md), `npm run bedrock:check` |
| Tested | `npm test`: unit, chaos, security and end-to-end through the official MCP SDK client |
| Measured, not asserted | [docs/SCALE.md](docs/SCALE.md); recall matching evaluated on 1,669 cases built from real notices (`npm run eval`) |
| Security reviewed, every finding has an attack test | [SECURITY.md](SECURITY.md) |

### Design: is it a coherent, intuitive experience?
- One screen, one voice: ask, hear the answer, see a receipt card for anything that needs a decision. Voice (wake word "Alexa", follow-ups without repeating it) and typing both work.
- Every irreversible step has a visible **Cancel order** within 10 minutes, and the page has **Forget my data**.
- The receipt card is an MCP App; its buttons call tools back over MCP rather than going around the protocol.
- Replies are written to be spoken: short, no markup, locale-correct money, English, Spanish and Hindi.

### Potential Impact: a specific need, beyond the hackathon?
- Recalls are published but owners are rarely reached; [docs/PROBLEM.md](docs/PROBLEM.md) cites the regulator figures and says plainly what is *not* claimed.
- Agents that can spend money need a standard safety pattern. `plan_restock` / `confirm_restock` / `undo_restock`, operator-set ceilings the model cannot change, and a hash-chained audit log are that pattern, reusable by any MCP server.
- Deployable: compiled build, `/readyz`, `/metrics`, graceful shutdown, online backups, Dockerfile (written, not yet built in CI).

### Quality of the Idea: creative, and true to the ecosystem and the end user?
- Proactive rather than reactive: new recalls are matched to owners by a brand index (37 ms to find 1,250 owners among 5,000 households) and pushed to open sessions.
- Matching only says "likely" with a model-number hit, so it does not cry wolf: 0% false alerts on unrelated products of the same brand in the evaluation.
- Built on what the Alexa+ track asks for: MCP, Streamable HTTP, Agent Skills, and honest product feedback ([docs/FRICTION_LOG.md](docs/FRICTION_LOG.md)).

## What is simulated, and what is not
- **Real:** the MCP server, OAuth/PKCE, the recall data (10,000+ notices), the matching, the forecast, the safety layer, the Bedrock calls.
- **Simulated:** the Alexa+ device (the web page is a real MCP client standing in for it, as the FAQ allows) and the storefront (`StoreAdapter`; no real purchases).
- **Synthetic:** the three sample households in `data/`. You can import your own order export from the page.
- **Not yet verified:** the container image build, live microphone behaviour across every browser, and forecast accuracy on a large set of real purchase histories.

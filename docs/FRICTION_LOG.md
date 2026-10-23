# Friction log

Entries are things actually encountered while building Hearth for the Alexa+ track.

## 1. Alexa+ add-on auth behavior is unclear against the MCP authorization spec
- **Task:** work out how an Alexa+ add-on's MCP server should respond to unauthenticated requests.
- **Steps:** read the Alexa+ MCP toolkit quickstart auth checklist (via search results, since the tooling is gated).
- **Expected:** guidance consistent with the MCP authorization spec.
- **Actual:** the summary said unauthenticated requests should get a 401 *without* a `WWW-Authenticate` header, while spec-based discovery relies on that header to find the protected-resource metadata.
- **Severity:** medium.
- **Workaround:** Hearth returns the header and RFC 9728 metadata.
- **Suggestion:** state which behavior Alexa+ requires, and why. (Not verified against the live page; flagged as a question.)

## 2. Alexa+ developer tools are partner-only, and only the FAQ says so
- **Task:** decide whether an Alexa+ build is feasible without device tooling.
- **Expected:** a clear statement in the track description.
- **Actual:** the Category SDK, MCP Toolkit, CLI and Web Simulator are described as unavailable only in the FAQ (which itself notes the gap on setup pages).
- **Severity:** medium (lost planning time).
- **Workaround:** simulated-client path (a web page acting as a real MCP client), which the FAQ allows.
- **Suggestion:** put the gating notice at the top of the track description and on every setup page.

## 3. No reference host for MCP Apps
- **Task:** show an MCP Apps view to judges.
- **Expected:** a minimal reference host to test a view against.
- **Actual:** none found; the host (iframe, initialize handshake, tool-result, tools/call proxying, size-changed, open-link) was written from the spec.
- **Severity:** medium (about half a day).
- **Workaround:** `web/appHost.js`.
- **Suggestion:** ship a small reference host and sandbox proxy with the ext-apps spec. Also, the Apps spec uses its own protocol version string (2026-01-26) next to MCP 2025-11-25, which is confusing at first.

## 4. Repo-visibility wording on the rules page
- **Task:** read the code-repository requirement.
- **Expected:** one clear conditional rule.
- **Actual:** the rules page contains the first-person sentence "Make sure this repo is private, then add these GitHub users as collaborators so they can review my submission" next to the "public with license OR private and shared" option. It reads like pasted form text and contradicts the public path.
- **Severity:** low.
- **Workaround:** followed the FAQ.
- **Suggestion:** reword as a conditional ("If your repo is private, add...").

## 5. Submission form: Friction Log field accepts only a URL
- **Task:** submit this log.
- **Expected:** a text area, as the field description lists several sub-items to include.
- **Actual:** the field validates as a URL ("must be a URL"), so the log has to be hosted elsewhere.
- **Severity:** low.
- **Workaround:** this file, linked from the form (the repo must be shared with reviewers or public for the link to resolve).
- **Suggestion:** make it a text area or say it must be a link.

## 6. Bedrock: which models an account can call is only discoverable by failing
- **Task:** call Claude Haiku from a free-plan account (region locked to Sydney) through the Converse API.
- **Steps:** set `BEDROCK_MODEL_ID` to the newest Haiku id.
- **Expected:** the console model catalog shows what this account may invoke.
- **Actual:** `AccessDenied: ... not available for this account` at call time. Models need a region-specific inference-profile prefix (`au.`, `us.`, ...) and only some are callable on a free plan (Haiku 4.5 and four Nova models worked; Haiku 5.5 did not).
- **Severity:** medium (an hour, plus a probe script written to find a callable model: `npm run bedrock:probe`).
- **Workaround:** the probe script tries a short list of cheap models and reports which work.
- **Suggestion:** show "callable by this account in this region" per model, with the exact inference-profile id, on the model catalog and in the API error.

## 7. Bedrock API keys: short-term keys cannot be listed or revoked
- **Task:** rotate a key that was exposed in a screenshot.
- **Expected:** a list of active keys with a revoke button for each kind.
- **Actual:** the short-term tab only offers "Generate"; revocation exists for long-term keys, so the console nudges people toward the riskier long-lived kind to get a delete button.
- **Severity:** medium (security-relevant).
- **Workaround:** let the short-term key expire (at most 12 hours) and generate a new one.
- **Suggestion:** list short-term keys with a revoke action, or say plainly on that tab that expiry is the only control.

## 8. Bedrock Converse: momentary `ServiceUnavailableException` in the middle of a tool-use conversation
- **Task:** run a spoken Alexa+-style conversation on Claude Haiku 4.5.
- **Actual:** one live turn failed with `ServiceUnavailableException` even though the same account had answered seconds earlier. A voice assistant cannot show an error page, so each hop needs its own retry and fallback.
- **Severity:** medium.
- **Workaround:** bounded retries with backoff for the documented transient errors, then a fall-back answer for that turn (tested with a stand-in Converse server).
- **Suggestion:** document the recommended retry policy for Converse tool-use loops, and which errors are safe to retry mid-conversation.

## 9. MCP Apps: `visibility: ["app"]` is advisory, so a server cannot tell who called
- **Task:** make an order approval that a prompt-injected model cannot forge.
- **Expected:** a way for the server to refuse a model-originated call to an app-only tool.
- **Actual:** the server sees the same `tools/call` whether the card or the model made it; enforcement lives entirely in the host (our own first host leaked app-only tools to the model, found and fixed in review).
- **Severity:** medium.
- **Workaround:** a one-time code shown only on the card and never given to the model, plus stripping app-only tools server-side before any model call.
- **Suggestion:** have hosts mark each `tools/call` with its origin (`app` or `model`), ideally signed, so servers can enforce visibility themselves.

## 10. Submission form: video link becomes required while other steps still save
- **Task:** edit the story after filling the draft.
- **Actual:** the Project details step blocks saving in the browser until a video URL exists, although earlier edits to the same step saved without one.
- **Severity:** low.
- **Workaround:** none needed once the video exists.
- **Suggestion:** keep the video optional for drafts, or say it is required up front.

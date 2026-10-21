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

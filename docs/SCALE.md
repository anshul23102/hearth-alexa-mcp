# Scale and accuracy: measured, not claimed

Everything here is reproducible from this repo. Machine: one MacBook, Node 26, SQLite file on local disk, no cache servers.

## Data volume
- **10,505 real recall notices** indexed locally: 5,287 U.S. CPSC (2010 to Oct 2026) and 5,218 Health Canada consumer-product recalls.
  One-time live sync of both feeds: about 12 to 16 s. Refreshed every 6 h in the background, never in a request.
- **676,365 synthetic order rows across 5,000 households** (messy: mixed dates and currencies, duplicates, cancellations).

## Throughput and latency (`npm run bench -- 5000 200`)
| Measurement | Result |
|---|---|
| Import, in-process, one transaction per household | 53,000 rows/s (676k rows in 12.7 s) |
| Forecast for one household | p50 0.41 ms, p95 0.55 ms, p99 0.72 ms |
| Recall check for one household (3 durables, 10.5k notices) | p50 0.18 ms, p95 0.24 ms, p99 1.0 ms (brand cache warm; 17 ms cold) |
| Database | 631,652 order rows = 154 MB |

## Proactive alerts: one new recall, every owner (`test/alerts.test.ts`)
With 5,000 households each owning one of four durables, a new notice is matched to its 1,250 owners and 1,250 alerts are written in
**37 ms** (brand index lookup, then the same scorer as the "ask" path). The push then goes only to those households' open MCP sessions.

## Big upload while the server keeps serving (`POST /api/import`, worker thread)
A single **500,000-row, 43.5 MB CSV** streamed over HTTP imported in **12.4 s**. A second client probing `/healthz` every 50 ms
during the upload saw **p50 3 ms, p99 13 ms, max 38 ms** (1,024 probes), so a huge import does not stall other households.

## Recall-matching accuracy (`npm run eval`)
Cases are generated from 4,612 real CPSC notices. Positives are built from the notice's own product name and model, so
positive numbers are an **upper bound**; the negatives are the number to watch.

| Case | n | Result |
|---|---|---|
| Owned product is in a notice: right recall surfaced at all | 1,669 | **85.4%** |
| ...flagged as confident ("likely") | 1,669 | **78.6%** |
| Same brand, unrelated product | 1,669 | 0.0% any alert |
| Third-party replacement part for the brand's product | 1,669 | 0.4% any alert, 0.0% "likely" |
| Same brand and product type, **wrong model number** | 1,669 | 2.1% false "likely"; 78.9% get a cautious "possible, verify the label" |

Reading it honestly: the 21% of true positives that are not "likely" mostly lack a model number that survives the title
noise; they still surface as "possible" or are missed (14.6% missed). The deliberate trade is that a wrong-model owner sees a
*possible* alert with "verify your label". That is safer than silence, but it is where alert fatigue would come from, and
it is the first thing to tune with real order data.

## Production build (compiled JS, `npm run build && npm run start:prod`)
The same 500,000-row, 43.5 MB upload through the **compiled** server and its worker thread: 13.4 s, `/readyz` ready, structured request log,
metrics counted the rows, and SIGTERM exited cleanly. The Dockerfile uses this exact build; it has not itself been built (no Docker where it was written).

## What this does not show
- No real customer data. Household behavior is synthetic, so forecast accuracy on real purchases is untested.
- One node, SQLite. The importer and brand cache are single-process; a fleet needs Postgres, a queue, and a shared rate-limit store.
- Brand-substring candidate search is fine at 10k notices; at millions you would move to a proper text index.

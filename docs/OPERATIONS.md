# Running Hearth for real

```bash
npm run build && npm run start:prod         # compiled JS, no tsx at runtime
# or: docker compose up --build              # non-root, read-only filesystem, healthcheck (compose file not built in CI here)
npm run backup -- backups/hearth-$(date +%F).db   # online, verified SQLite backup
```
Set `PUBLIC_URL` and `HEARTH_ALLOWED_HOSTS` behind a domain. `/healthz` and `/readyz` for probes; `/metrics` (Prometheus) turns on with
`HEARTH_METRICS_TOKEN`; JSON request logs go to stdout; SIGTERM drains and checkpoints the database. CI (`.github/workflows/ci.yml`)
runs typecheck, build, tests and `npm audit`. Demo the alert pipeline: start with `HEARTH_ADMIN_TOKEN=<24+ chars>` then
`HEARTH_ADMIN_TOKEN=<same> npm run demo:recall -- Foodi` while the simulator is open.


## Configuration

Every setting is optional and documented in [`.env.example`](../.env.example).

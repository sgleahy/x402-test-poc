# $ELEC live backend — Railway deployment guide

Turns the validated load-weighted, winsorized composite (backtested against
2 years of history, see `elec_final_hourly.csv`) into a live, continuously
updating feed served through the existing x402 payment gate.

## Architecture

Three pieces in one Railway project:

1. **`server/`** (Node/Express, already existed as the x402 POC) — polls
   GridStatus.io's paid REST API every 15 min for the latest price at each
   of the 7 hubs, recomputes the composite, and serves it behind the x402
   payment gate at `/api/elec/*`. This is the only public-facing piece.
2. **`load-poller/`** (Python, new) — polls the free `gridstatus`
   open-source library every 60 min for the latest load at each of the 7
   ISOs, writes to the shared database. Not public-facing, no payment
   logic, nothing else.
3. **Railway Postgres** — shared by both services. Node writes price +
   composite, Python writes load, Node reads both to compute the number it
   serves.

**Why two languages for one product:** `gridstatus` (the free, no-cost load
data source you asked for) requires Python 3.11+ — there's no equivalent
free Node library. Rather than reimplement 7 ISOs' worth of already-painful
quirks in JavaScript, the working, debugged Python code stays Python. Price
data comes from the paid GridStatus.io REST API instead, which is plain
HTTP and fits naturally into the existing Node service — no second Python
process needed just for price.

**Cost:** within the $5–20/mo range you already approved. Two lightweight
services + a small Postgres instance, all low-traffic (a handful of HTTP
calls every 15–60 minutes).

## [YOU] Steps — things only you can do

1. **Railway account + project.** Go to railway.app, sign in with GitHub,
   create a new project.
2. **Push this code to GitHub** if it isn't already in a repo Railway can
   see. (You already have a working pattern for this via GitHub Desktop
   from the elec-finance-site deploy — same approach here.) The whole
   `x402-test-poc/` folder should be in the repo; `server/` and
   `load-poller/` will become two separate Railway services pointing at two
   different subdirectories of the same repo.
3. **Add a Postgres database** to the Railway project (Railway's "+ New" →
   "Database" → "PostgreSQL"). Railway auto-generates `DATABASE_URL`.
4. **Add the `server/` service:** "+ New" → "GitHub Repo" → select this
   repo → set **root directory** to `x402-test-poc/server`. Railway will
   auto-detect Node via `package.json` and run `npm run build && npm start`
   (confirm the build command is `npm run build`, start command
   `npm start` — adjust in service Settings if needed).
5. **Add the `load-poller/` service:** same repo, root directory
   `x402-test-poc/load-poller`. Railway should detect Python via
   `requirements.txt` + `runtime.txt` and use the `Procfile`'s
   `worker: python3 main.py`. If it defaults to a web process type instead,
   override the start command to `python3 main.py` in Settings.
6. **Attach the Postgres plugin to BOTH services** (Railway lets one
   database back multiple services in the same project) — this is what
   makes `DATABASE_URL` show up automatically in each service's variables.
7. **Set environment variables** on the `server/` service (Settings →
   Variables): everything currently in `server/.env.example`, real values —
   `PAY_TO_ADDRESS`, `JWT_SECRET`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`,
   `GRIDSTATUS_API_KEY`. **Rotate the GridStatus.io API key** before setting
   it — the current one (`4ae26411127b49d4ad3c0e15b6863efe`) has been
   sitting in plaintext in `pull_2yr_history.sh`; get a fresh one from your
   GridStatus.io account dashboard.
8. **Set environment variables** on the `load-poller/` service:
   `PJM_API_KEY` (the one you already obtained from PJM), optionally
   `POLL_INTERVAL_MINUTES` (defaults to 60).
9. **Run the schema migration once**, against the Railway Postgres, before
   either service starts writing: copy the `DATABASE_URL` from the Postgres
   service's Variables tab, then from your Mac terminal (needs `psql`
   installed — `brew install postgresql` if you don't have it):
   ```
   psql "<paste DATABASE_URL here>" -f server/migrations/001_init.sql
   ```
10. **Deploy both services** (Railway deploys automatically on push once
    connected — or click Deploy manually the first time).
11. **Smoke-test:** hit `https://<your-server-service>.up.railway.app/api/elec/status`
    in a browser. Right after deploy it'll say `composite_available: false`
    — give it 15–20 minutes for both pollers to run at least once, then
    check again. Watch the Railway logs for both services for the first
    hour to confirm no per-ISO errors (this is genuinely likely on the
    first live run — see note below).

## [Already done] What's built and ready

- `server/migrations/001_init.sql` — Postgres schema (3 tables:
  `hub_prices_live`, `hub_loads_live`, `elec_composite_live`).
- `server/src/price-poller.ts` — polls GridStatus.io REST for all 7 hubs.
- `server/src/composite.ts` — load-weighted + winsorized composite
  calculation, same methodology validated in the 2-year backtest.
- `server/src/scheduler.ts` — runs the poll + recompute loop every
  `POLL_INTERVAL_MINUTES` (default 15).
- `server/src/routes/elec.ts` — new `/api/elec/status` (public),
  `/api/elec/access` (x402-gated, issues session JWT), `/api/elec/latest`
  and `/api/elec/history` (JWT-protected) — same auth pattern as the
  original `/api/test/*` POC routes, which are left in place untouched.
- `load-poller/main.py` — polls all 7 ISOs' live load via the free
  `gridstatus` library, with the ERCOT/MISO double-counting bug fix and the
  PJM RTO-row filter already applied (see comments in the file — these bugs
  were found and fixed while building the historical backtest and would
  have silently corrupted live data too if carried over).
- TypeScript side typechecks clean (`npm run typecheck` in `server/`).
  Python side syntax-checked but **not live-tested** — see below.

## Known gaps / what to expect going live

- **The Python load-poller has not been run against real ISOs yet.**
  Everything in it reuses methods and parameter names already proven
  during the 2-year historical pull, but "latest data" queries are a
  different code path from "2-year history" queries for a few of these
  (especially ERCOT and SPP) — some per-ISO troubleshooting on first live
  run would not be surprising, same pattern as the historical pull. Watch
  the Railway logs for `[HUB] FAILED: ...` lines after first deploy.
- **PJM load may lag more than the other 6 hubs.** The `get_load_metered_hourly`
  endpoint is PJM's settlement feed, not a true real-time feed — a truer
  real-time PJM load source wasn't researched. If PJM's `hub_loads_live`
  rows are consistently more than a few hours stale, the composite's
  staleness check (6 hours for price, 12 for load) will just drop PJM from
  that hour's weighting rather than break anything, but it's worth knowing.
- **Winsorization needs ~30 days of live price history before it fully
  kicks in.** Until then, `composite.ts` falls back to using raw prices
  unwinsorized for hubs with fewer than 24 hours of trailing data — this is
  intentional (matches the backtest's bootstrap behavior) and self-resolves.
- **The x402 payment gate itself has not changed** — same CDP mainnet
  facilitator, same $0.05/hour pricing, same JWT session pattern already
  proven working in the July 2026 end-to-end test. Only the data behind it
  changed.

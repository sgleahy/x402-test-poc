/**
 * Polls the most recent price at each of the 7 $ELEC composite hubs and
 * upserts into hub_prices_live.
 *
 * ISO data source strategy:
 *   ERCOT    → ercot-direct.ts  (direct ISO API, no GridStatus)
 *   MISO     → miso-direct.ts   (direct ISO API, no GridStatus)
 *   NYISO    → nyiso-direct.ts  (direct ISO API — public CSV, no auth)
 *   PJM      → GridStatus.io    (TODO: build pjm-direct.ts)
 *   CAISO    → GridStatus.io    (TODO: build caiso-direct.ts)
 *   ISONE    → GridStatus.io    (TODO: build isone-direct.ts)
 *   SPP      → GridStatus.io    (TODO: build spp-direct.ts)
 *
 * GridStatus legal note: GridStatus's ToS (§4.2) prohibits using their
 * hosted API to build a competing or resold data product. That's our
 * business model. Direct ISO connections are required, not optional.
 * PJM/CAISO/ISONE/SPP are still on GridStatus as a *temporary bridge*
 * while those connectors are built. They will be migrated off GridStatus
 * one by one as each direct connector is tested and confirmed working.
 *
 * GridStatus quota note: free plan = 250 requests/month. The 15-min
 * poll cycle × 4 remaining GridStatus hubs = ~576 requests/day — blows
 * through the quota in under an hour. Either upgrade the GridStatus plan
 * or accept that those 4 hubs will return errors until direct connectors
 * replace them. The composite can still compute with 3-4 hubs (provisional).
 */
import { pool } from "./pg.js";
import { env } from "./env.js";
import { HUBS } from "./hubs.js";
import { pollErcotHubAvg } from "./ercot-direct.js";
import { pollMisoIndianaHub } from "./miso-direct.js";
import { pollNyisoZoneJ } from "./nyiso-direct.js";

const BASE = "https://api.gridstatus.io/v1/datasets";

// GridStatus.io's default plan caps at 3 requests/second (confirmed via
// their API usage docs). 400ms spacing keeps us under that on any plan tier.
// With only 4 hubs still on GridStatus, the full pass takes ~1.6s.
const REQUEST_SPACING_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GridStatusRow {
  interval_start_utc: string;
  [key: string]: unknown;
}

export interface PricePollResult {
  hub: string;
  ok: boolean;
  intervalStartUtc?: string;
  price?: number;
  error?: string;
}

// ── Direct-connector dispatch ───────────────────────────────────────────────
// These hubs are served by direct ISO connections. They do NOT go through
// the GridStatus fetch block below.
const DIRECT_HUB_SET = new Set(["ERCOT_HB_HUBAVG", "MISO_INDIANA", "NYISO_ZONEJ"]);

export async function pollLatestPrices(): Promise<PricePollResult[]> {
  const now = new Date();
  const results: PricePollResult[] = [];
  let gridStatusCallCount = 0;

  for (const [i, cfg] of HUBS.entries()) {
    // ── Direct connectors ─────────────────────────────────────────────────
    if (cfg.hub === "ERCOT_HB_HUBAVG") {
      const r = await pollErcotHubAvg();
      await upsertIfOk(cfg.hub, r.intervalStartUtc, r.price);
      results.push({ hub: cfg.hub, ...r });
      continue;
    }

    if (cfg.hub === "MISO_INDIANA") {
      const r = await pollMisoIndianaHub();
      await upsertIfOk(cfg.hub, r.intervalStartUtc, r.price);
      results.push({ hub: cfg.hub, ...r });
      continue;
    }

    if (cfg.hub === "NYISO_ZONEJ") {
      const r = await pollNyisoZoneJ();
      await upsertIfOk(cfg.hub, r.intervalStartUtc, r.price);
      results.push({ hub: cfg.hub, ...r });
      continue;
    }

    // ── GridStatus fallback (4 remaining hubs) ────────────────────────────
    if (gridStatusCallCount > 0 || i > 0) await sleep(REQUEST_SPACING_MS);
    gridStatusCallCount++;

    const start = new Date(now.getTime() - cfg.maxLagHours * 60 * 60 * 1000);

    const url = new URL(`${BASE}/${cfg.dataset}/query/location/${encodeURIComponent(cfg.location)}`);
    url.searchParams.set("api_key", env.GRIDSTATUS_API_KEY);
    url.searchParams.set("start_time", start.toISOString());
    url.searchParams.set("end_time", now.toISOString());
    url.searchParams.set("limit", "200");

    try {
      const res = await fetch(url.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept": "application/json",
        },
      });

      if (!res.ok) {
        // Log HTTP status explicitly — GridStatus can return 429 (quota), 401
        // (invalid key), or 403 (plan limit) which all look different and need
        // different fixes. Don't swallow this into a generic "no rows" error.
        const snippet = (await res.text().catch(() => "")).slice(0, 200);
        results.push({
          hub: cfg.hub,
          ok: false,
          error: `GridStatus HTTP ${res.status} — ${snippet}`,
        });
        continue;
      }

      const body = (await res.json()) as { data?: GridStatusRow[] };
      const rows = body.data ?? [];

      if (rows.length === 0) {
        // HTTP 200 but no data — GridStatus quota exhaustion returns 200 with
        // an empty data array on the free plan. Check the API key plan tier.
        results.push({
          hub: cfg.hub,
          ok: false,
          error: `GridStatus returned no rows (HTTP 200 but empty data array — likely free-tier quota exhaustion; ${env.GRIDSTATUS_API_KEY ? "API key is set" : "API key MISSING"})`,
        });
        continue;
      }

      // Rows come back ascending — take the newest.
      const latest = rows[rows.length - 1];
      const price = latest[cfg.priceField];
      if (typeof price !== "number" || !latest.interval_start_utc) {
        results.push({ hub: cfg.hub, ok: false, error: "missing price/interval in GridStatus response" });
        continue;
      }

      await pool.query(
        `INSERT INTO hub_prices_live (hub, interval_start_utc, price_usd_mwh)
         VALUES ($1, $2, $3)
         ON CONFLICT (hub, interval_start_utc)
         DO UPDATE SET price_usd_mwh = EXCLUDED.price_usd_mwh, fetched_at = now()`,
        [cfg.hub, latest.interval_start_utc, price],
      );

      results.push({ hub: cfg.hub, ok: true, intervalStartUtc: latest.interval_start_utc, price });
    } catch (err) {
      results.push({ hub: cfg.hub, ok: false, error: (err as Error).message });
    }
  }

  return results;
}

// ── Shared upsert for direct connectors ────────────────────────────────────
async function upsertIfOk(hub: string, intervalStartUtc?: string, price?: number): Promise<void> {
  if (intervalStartUtc === undefined || price === undefined) return;
  try {
    await pool.query(
      `INSERT INTO hub_prices_live (hub, interval_start_utc, price_usd_mwh)
       VALUES ($1, $2, $3)
       ON CONFLICT (hub, interval_start_utc)
       DO UPDATE SET price_usd_mwh = EXCLUDED.price_usd_mwh, fetched_at = now()`,
      [hub, intervalStartUtc, price],
    );
  } catch (err) {
    // Log but don't re-throw — a DB error here shouldn't kill the whole poll cycle.
    console.error(`[price-poller] upsert failed for ${hub}:`, err);
  }
}

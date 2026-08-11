/**
 * Polls GridStatus.io's hosted API (the paid REST product, NOT the free
 * open-source library -- that one's Python-only and used separately by
 * ../load-poller for load data) for the most recent price at each of the
 * 7 hubs, and upserts into hub_prices_live.
 *
 * Kept in Node/HTTP (not Python) deliberately: GridStatus.io is a plain
 * REST API, so there's no reason to add a second language just for this.
 * Response shape confirmed against real saved responses from the 2-year
 * backfill: { status_code, data: [{ interval_start_utc, <priceField>, ... }], meta, dataset_metadata }.
 */
import { pool } from "./pg.js";
import { env } from "./env.js";
import { HUBS } from "./hubs.js";

const BASE = "https://api.gridstatus.io/v1/datasets";

// GridStatus.io's default plan caps at 3 requests/second (confirmed via
// their API usage docs). Observed live: firing all 7 hub requests back to
// back tripped HTTP 429 on 6 of 7. A fixed delay between requests keeps us
// well under that regardless of plan tier -- 400ms means the full 7-hub
// pass takes under 3s, trivial against a 15-minute poll interval.
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

export async function pollLatestPrices(): Promise<PricePollResult[]> {
  const now = new Date();
  const results: PricePollResult[] = [];

  for (const [i, cfg] of HUBS.entries()) {
    if (i > 0) await sleep(REQUEST_SPACING_MS);

    // Lookback window is per-hub (see cfg.maxLagHours in hubs.ts) -- day-ahead
    // datasets and the "final"/settled feeds (ISONE, MISO, PJM) all need much
    // wider windows than a true real-time feed like ERCOT's 15-min data.
    const start = new Date(now.getTime() - cfg.maxLagHours * 60 * 60 * 1000);

    const url = new URL(`${BASE}/${cfg.dataset}/query/location/${encodeURIComponent(cfg.location)}`);
    url.searchParams.set("api_key", env.GRIDSTATUS_API_KEY);
    url.searchParams.set("start_time", start.toISOString());
    url.searchParams.set("end_time", now.toISOString());
    url.searchParams.set("limit", "200");

    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        results.push({ hub: cfg.hub, ok: false, error: `HTTP ${res.status}` });
        continue;
      }
      const body = (await res.json()) as { data?: GridStatusRow[] };
      const rows = body.data ?? [];
      if (rows.length === 0) {
        results.push({ hub: cfg.hub, ok: false, error: "no rows in lookback window" });
        continue;
      }

      // Rows come back ascending by interval_start_utc -- take the newest.
      const latest = rows[rows.length - 1];
      const price = latest[cfg.priceField];
      if (typeof price !== "number" || !latest.interval_start_utc) {
        results.push({ hub: cfg.hub, ok: false, error: "missing price/interval in response row" });
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

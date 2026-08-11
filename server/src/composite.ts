/**
 * Live $ELEC composite: load-weighted average of the 7 hub prices, with
 * per-hub outlier capping (winsorization against each hub's own trailing
 * 30-day 1st/99th percentile band, using only data strictly BEFORE the
 * current hour -- no lookahead).
 *
 * This mirrors the methodology validated against 2 years of history in
 * build_load_weighted_composite.py + add_winsorization.py (see project
 * memory for backtest results: mean $41.44/MWh, corr 0.91 vs naive avg,
 * max spike damped from $1,051 to $470). The 1st/99th percentile band is
 * computed here via Postgres percentile_cont instead of pandas -- same
 * math, just pushed into SQL since the rolling window lives in the DB now.
 */
import { pool } from "./pg.js";
import { HUB_NAMES } from "./hubs.js";

const WINSOR_WINDOW_DAYS = 30;
const MIN_PERIODS_FOR_WINSOR = 24; // need >=1 day of trailing history before capping kicks in
const PRICE_STALENESS_HOURS = 6; // ignore a hub's price if older than this
const LOAD_STALENESS_HOURS = 12; // load updates less frequently than price

export interface HubDetail {
  hub: string;
  price: number | null;
  priceCapped: number | null;
  wasCapped: boolean;
  load: number | null;
  weight: number | null;
}

export interface CompositeResult {
  hourUtc: string;
  elecPrice: number;
  nHubsAvailable: number;
  nHubsCapped: number;
  detail: HubDetail[];
}

export async function computeAndStoreLatestComposite(): Promise<CompositeResult | null> {
  const client = await pool.connect();
  try {
    const detail: HubDetail[] = [];
    let latestIntervalUtc: string | null = null;

    for (const hub of HUB_NAMES) {
      const priceRes = await client.query<{ interval_start_utc: string; price_usd_mwh: string }>(
        `SELECT interval_start_utc, price_usd_mwh FROM hub_prices_live
         WHERE hub = $1 AND interval_start_utc > now() - interval '${PRICE_STALENESS_HOURS} hours'
         ORDER BY interval_start_utc DESC LIMIT 1`,
        [hub],
      );
      const loadRes = await client.query<{ load_mw: string }>(
        `SELECT load_mw FROM hub_loads_live
         WHERE hub = $1 AND interval_start_utc > now() - interval '${LOAD_STALENESS_HOURS} hours'
         ORDER BY interval_start_utc DESC LIMIT 1`,
        [hub],
      );

      const price = priceRes.rows[0] ? Number(priceRes.rows[0].price_usd_mwh) : null;
      const load = loadRes.rows[0] ? Number(loadRes.rows[0].load_mw) : null;

      if (priceRes.rows[0] && (!latestIntervalUtc || priceRes.rows[0].interval_start_utc > latestIntervalUtc)) {
        latestIntervalUtc = priceRes.rows[0].interval_start_utc;
      }

      let priceCapped = price;
      let wasCapped = false;

      if (price !== null) {
        const bandRes = await client.query<{ p01: string | null; p99: string | null; n: string }>(
          `SELECT
             percentile_cont(0.01) WITHIN GROUP (ORDER BY price_usd_mwh) AS p01,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY price_usd_mwh) AS p99,
             count(*) AS n
           FROM hub_prices_live
           WHERE hub = $1
             AND interval_start_utc >= now() - interval '${WINSOR_WINDOW_DAYS} days'
             AND interval_start_utc < now() - interval '1 hour'`,
          [hub],
        );
        const row = bandRes.rows[0];
        if (row && Number(row.n) >= MIN_PERIODS_FOR_WINSOR && row.p01 !== null && row.p99 !== null) {
          const p01 = Number(row.p01);
          const p99 = Number(row.p99);
          if (price < p01) {
            priceCapped = p01;
            wasCapped = true;
          } else if (price > p99) {
            priceCapped = p99;
            wasCapped = true;
          }
        }
      }

      detail.push({ hub, price, priceCapped, wasCapped, load, weight: null });
    }

    if (!latestIntervalUtc) return null;

    const validHubs = detail.filter((d) => d.priceCapped !== null && d.load !== null && d.load > 0);
    if (validHubs.length === 0) return null;

    const totalLoad = validHubs.reduce((sum, d) => sum + (d.load as number), 0);
    let elecPrice = 0;
    for (const d of validHubs) {
      d.weight = (d.load as number) / totalLoad;
      elecPrice += (d.priceCapped as number) * d.weight;
    }

    const nHubsCapped = detail.filter((d) => d.wasCapped).length;

    await client.query(
      `INSERT INTO elec_composite_live (hour_utc, elec_price, n_hubs_available, n_hubs_capped, detail)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (hour_utc) DO UPDATE SET
         elec_price = EXCLUDED.elec_price,
         n_hubs_available = EXCLUDED.n_hubs_available,
         n_hubs_capped = EXCLUDED.n_hubs_capped,
         detail = EXCLUDED.detail,
         computed_at = now()`,
      [latestIntervalUtc, elecPrice, validHubs.length, nHubsCapped, JSON.stringify(detail)],
    );

    return {
      hourUtc: latestIntervalUtc,
      elecPrice,
      nHubsAvailable: validHubs.length,
      nHubsCapped,
      detail,
    };
  } finally {
    client.release();
  }
}

export interface HubDiagnostic {
  hub: string;
  price_age_minutes: number | null;
  price_fresh: boolean;
  load_age_minutes: number | null;
  load_fresh: boolean;
}

/**
 * TEMPORARY diagnostic endpoint helper -- root-causing why n_hubs_available
 * is stuck at 1. Reports only freshness (age in minutes vs the staleness
 * cutoffs), never the actual price/load values, so it doesn't leak the paid
 * /api/elec/latest product for free. Safe to remove once the stuck-hub bug
 * is found and fixed.
 */
export async function getHubDiagnostics(): Promise<HubDiagnostic[]> {
  const out: HubDiagnostic[] = [];
  for (const hub of HUB_NAMES) {
    const priceRes = await pool.query<{ interval_start_utc: string }>(
      `SELECT interval_start_utc FROM hub_prices_live WHERE hub = $1 ORDER BY interval_start_utc DESC LIMIT 1`,
      [hub],
    );
    const loadRes = await pool.query<{ interval_start_utc: string }>(
      `SELECT interval_start_utc FROM hub_loads_live WHERE hub = $1 ORDER BY interval_start_utc DESC LIMIT 1`,
      [hub],
    );
    const priceAge = priceRes.rows[0]
      ? (Date.now() - new Date(priceRes.rows[0].interval_start_utc).getTime()) / 60000
      : null;
    const loadAge = loadRes.rows[0]
      ? (Date.now() - new Date(loadRes.rows[0].interval_start_utc).getTime()) / 60000
      : null;
    out.push({
      hub,
      price_age_minutes: priceAge === null ? null : Math.round(priceAge),
      price_fresh: priceAge !== null && priceAge <= PRICE_STALENESS_HOURS * 60,
      load_age_minutes: loadAge === null ? null : Math.round(loadAge),
      load_fresh: loadAge !== null && loadAge <= LOAD_STALENESS_HOURS * 60,
    });
  }
  return out;
}

export async function getLatestComposite(): Promise<CompositeResult | null> {
  const res = await pool.query<{
    hour_utc: string;
    elec_price: string;
    n_hubs_available: number;
    n_hubs_capped: number;
    detail: HubDetail[];
  }>(`SELECT hour_utc, elec_price, n_hubs_available, n_hubs_capped, detail
      FROM elec_composite_live ORDER BY hour_utc DESC LIMIT 1`);
  const row = res.rows[0];
  if (!row) return null;
  return {
    hourUtc: row.hour_utc,
    elecPrice: Number(row.elec_price),
    nHubsAvailable: row.n_hubs_available,
    nHubsCapped: row.n_hubs_capped,
    detail: row.detail,
  };
}

export async function getCompositeHistory(sinceHours: number): Promise<CompositeResult[]> {
  const res = await pool.query<{
    hour_utc: string;
    elec_price: string;
    n_hubs_available: number;
    n_hubs_capped: number;
    detail: HubDetail[];
  }>(
    `SELECT hour_utc, elec_price, n_hubs_available, n_hubs_capped, detail
     FROM elec_composite_live
     WHERE hour_utc > now() - interval '${sinceHours} hours'
     ORDER BY hour_utc ASC`,
  );
  return res.rows.map((row) => ({
    hourUtc: row.hour_utc,
    elecPrice: Number(row.elec_price),
    nHubsAvailable: row.n_hubs_available,
    nHubsCapped: row.n_hubs_capped,
    detail: row.detail,
  }));
}

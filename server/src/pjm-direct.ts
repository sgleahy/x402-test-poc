/**
 * Direct PJM connector — polls WESTERN HUB real-time 5-min LMP
 * from PJM's Data Miner 2 API, bypassing GridStatus.io.
 *
 * Auth: subscriptionkey query parameter (from PJM API portal).
 * Data: rt_unverified_fivemin_lmps — 5-min real-time LMPs, published
 *       with minimal lag (~5-10 min). "Unverified" = preliminary; good
 *       enough for a real-time price feed.
 *
 * Required env var (set in Railway dashboard):
 *   PJM_API_KEY  — subscription key from dataminer2.pjm.com developer portal
 *
 * API docs: https://dataminer2.pjm.com/api/doc
 * Hub:      WESTERN HUB (PJM's main Western Pennsylvania pricing node)
 *
 * Note: PJM's API does NOT use Akamai WAF — direct fetch works from Railway.
 * No proxy needed.
 */

import { env } from "./env.js";

const PJM_API_BASE = "https://dataminer2.pjm.com/feed";
const PJM_HUB = "WESTERN HUB";

export interface PjmPollResult {
  ok: boolean;
  intervalStartUtc?: string;
  price?: number;
  error?: string;
}

interface PjmLmpRow {
  datetime_beginning_utc?: string;
  datetime_beginning_ept?: string;
  pnode_id?: number;
  pnode_name?: string;
  type?: string;
  voltage?: string;
  equipment?: string;
  zone?: string;
  system_energy_price_rt?: number;
  total_lmp_rt?: number;
  congestion_price_rt?: number;
  marginal_loss_price_rt?: number;
}

export async function pollPjmWesternHub(): Promise<PjmPollResult> {
  if (!env.PJM_API_KEY) {
    return { ok: false, error: "PJM_API_KEY not configured" };
  }

  try {
    // Fetch the last 2 hours of 5-min intervals for WESTERN HUB.
    // Data Miner 2 paginates at 500 rows per page; 2h × 12 intervals/hr = 24 rows,
    // well within one page. rowCount=50 gives headroom without over-fetching.
    const url = new URL(`${PJM_API_BASE}/rt_unverified_fivemin_lmps`);
    url.searchParams.set("subscriptionkey", env.PJM_API_KEY);
    url.searchParams.set("rowCount", "50");
    url.searchParams.set("startRow", "1");
    // Filter server-side to the hub we want — avoids downloading all nodes.
    // PJM field filter syntax: field=value (exact match, case-insensitive).
    url.searchParams.set("pnode_name", PJM_HUB);

    const res = await fetch(url.toString(), {
      headers: {
        "Accept": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
    });

    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, error: `PJM HTTP ${res.status} — ${snippet}` };
    }

    const body = (await res.json()) as { items?: PjmLmpRow[]; totalRows?: number } | PjmLmpRow[];

    // Data Miner 2 wraps results in { items: [...] } but some endpoints return an array directly.
    let rows: PjmLmpRow[];
    if (Array.isArray(body)) {
      rows = body;
    } else if (body && typeof body === "object" && Array.isArray((body as { items?: PjmLmpRow[] }).items)) {
      rows = (body as { items: PjmLmpRow[] }).items;
    } else {
      return {
        ok: false,
        error: `PJM response shape unexpected — got: ${JSON.stringify(body).slice(0, 200)}`,
      };
    }

    if (rows.length === 0) {
      return { ok: false, error: `PJM returned 0 rows for ${PJM_HUB} — check PJM_API_KEY plan tier` };
    }

    // Filter client-side as a safety net (server-side filter might not apply on all API versions).
    const hubRows = rows.filter(
      (r) =>
        typeof r.pnode_name === "string" &&
        r.pnode_name.toUpperCase().includes("WESTERN"),
    );

    const targetRows = hubRows.length > 0 ? hubRows : rows;

    // Rows come back ascending — last row is most recent.
    const latest = targetRows[targetRows.length - 1];

    // Price field: total_lmp_rt is the full LMP (energy + congestion + losses).
    const price = latest.total_lmp_rt ?? latest.system_energy_price_rt;
    const intervalStartUtc = latest.datetime_beginning_utc ?? latest.datetime_beginning_ept;

    if (typeof price !== "number") {
      return {
        ok: false,
        error: `PJM response missing price field. Row keys: ${Object.keys(latest).join(",")}`,
      };
    }
    if (!intervalStartUtc) {
      return {
        ok: false,
        error: `PJM response missing timestamp field. Row keys: ${Object.keys(latest).join(",")}`,
      };
    }

    return { ok: true, intervalStartUtc, price };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

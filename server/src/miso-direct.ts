/**
 * Direct connection to MISO's Data Exchange Pricing API for INDIANA.HUB
 * real-time LMP -- bypasses GridStatus.io entirely, same rationale as
 * ercot-direct.ts (GridStatus's ToS prohibits building a competing/resold
 * product on their data).
 *
 * Simpler auth than ERCOT: a single static subscription key header, no
 * OAuth token to mint/refresh.
 *
 * Endpoint confirmed live via MISO's own "Try it" console in the Data
 * Exchange developer portal (data-exchange.misoenergy.org), 2026-08-18:
 *   GET https://apim.misoenergy.org/pricing/v1/real-time/{date}/lmp-expost
 *       ?node=INDIANA.HUB&pageNumber=1&preliminaryFinal=Preliminary&timeResolution=5min
 * Header: Ocp-Apim-Subscription-Key: <key>
 *
 * Response is genuine 5-minute real-time LMP (preliminaryFinal="Preliminary"
 * means not-yet-settled/near-real-time, as opposed to "Final" which lags
 * days -- Preliminary is the fresh one we want, and it's a real improvement
 * over what GridStatus was giving us for this hub). A full day is 288
 * intervals, confirmed to fit in a single page (pageSize 1000,
 * totalElements 288, totalPages 1) -- no pagination needed.
 *
 * TIMEZONE ASSUMPTION (unverified -- same caveat as ercot-direct.ts's DST
 * edge case): timeInterval.value comes back as a naive "YYYY-MM-DDTHH:mm:ss"
 * string with no UTC offset. Assuming this is MISO's Eastern Prevailing
 * Time (America/New_York, DST-aware), based on (a) MISO's free ExAnte LMP
 * endpoint explicitly labeling its timestamps "EST", and (b) every other
 * ISO in this codebase using a local-prevailing-time convention. If live
 * data ever looks off by a fixed number of hours, this is the first thing
 * to check -- compare the latest interval's start time against actual
 * wall-clock time on a live "today" pull.
 */
import { pool } from "./pg.js";

const BASE_URL = "https://apim.misoenergy.org/pricing/v1/real-time";

interface MisoLmpRow {
  timeInterval: { resolution: string; start: string; end: string; value: string };
  preliminaryFinal: string;
  node: string;
  lmp: number;
  mcc: number;
  mec: number;
  mlc: number;
}

interface MisoLmpResponse {
  data?: MisoLmpRow[];
  page?: { pageNumber: number; pageSize: number; totalElements: number; totalPages: number; lastPage: boolean };
}

// Same local-time -> UTC conversion approach as ercot-direct.ts, just
// against America/New_York instead of America/Chicago.
function getTimeZoneOffsetMs(approxInstant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(approxInstant).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const asIfUtcAgain = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    parts.hour === "24" ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtcAgain - approxInstant.getTime();
}

function localNaiveToUtcIso(localWallClock: string): string {
  // localWallClock like "2026-08-17T00:05:00" (no offset), assumed Eastern.
  const asIfUtc = new Date(`${localWallClock}Z`);
  const offsetMs = getTimeZoneOffsetMs(asIfUtc, "America/New_York");
  return new Date(asIfUtc.getTime() - offsetMs).toISOString();
}

export interface MisoPollResult {
  ok: boolean;
  intervalStartUtc?: string;
  price?: number;
  error?: string;
}

/**
 * Fetches the latest INDIANA.HUB 5-min real-time LMP and upserts into
 * hub_prices_live -- drop-in replacement for MISO_INDIANA's row, same
 * pattern as pollErcotHubAvg().
 */
export async function pollMisoIndianaHub(): Promise<MisoPollResult> {
  const subscriptionKey = process.env.MISO_SUBSCRIPTION_KEY;
  if (!subscriptionKey) {
    return { ok: false, error: "MISO_SUBSCRIPTION_KEY not set" };
  }

  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Try today first; fall back to yesterday only if today has no rows yet
    // (e.g. just after UTC midnight, before MISO's Eastern-time day has
    // produced any intervals).
    for (const date of [today, yesterday]) {
      const url = new URL(`${BASE_URL}/${date}/lmp-expost`);
      url.searchParams.set("node", "INDIANA.HUB");
      url.searchParams.set("pageNumber", "1");
      url.searchParams.set("preliminaryFinal", "Preliminary");
      url.searchParams.set("timeResolution", "5min");

            const res = await fetch(url.toString(), {
        headers: {
          "Ocp-Apim-Subscription-Key": subscriptionKey,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      });

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        if (date === today) continue; // try yesterday before giving up
        return { ok: false, error: `HTTP ${res.status} ${bodyText.slice(0, 200)}` };
      }

      const body = (await res.json()) as MisoLmpResponse;
      const rows = body.data ?? [];
      if (rows.length === 0) {
        if (date === today) continue;
        return { ok: false, error: "no rows returned for INDIANA.HUB" };
      }

      if (body.page && !body.page.lastPage) {
        console.warn(
          `[miso-direct] response is paginated (page ${body.page.pageNumber}/${body.page.totalPages}) -- ` +
            "only reading page 1. Unexpected for a single-node, single-day query; investigate if seen.",
        );
      }

      // Rows come back ascending by time (confirmed from the sample: 00:00,
      // 00:05, 00:10, ...) -- take the latest.
      rows.sort((a, b) => a.timeInterval.value.localeCompare(b.timeInterval.value));
      const latest = rows[rows.length - 1];

      const price = Number(latest.lmp);
      if (!Number.isFinite(price)) {
        return { ok: false, error: `non-numeric lmp: ${latest.lmp}` };
      }

      const intervalStartUtc = localNaiveToUtcIso(latest.timeInterval.value);

      await pool.query(
        `INSERT INTO hub_prices_live (hub, interval_start_utc, price_usd_mwh)
         VALUES ($1, $2, $3)
         ON CONFLICT (hub, interval_start_utc)
         DO UPDATE SET price_usd_mwh = EXCLUDED.price_usd_mwh, fetched_at = now()`,
        ["MISO_INDIANA", intervalStartUtc, price],
      );

      return { ok: true, intervalStartUtc, price };
    }

    return { ok: false, error: "no rows returned for INDIANA.HUB in today or yesterday" };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

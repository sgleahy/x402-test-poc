/**
 * Direct MISO connector — polls INDIANA.HUB real-time 5-min LMP
 * from MISO's own Data Exchange API, bypassing GridStatus.io.
 *
 * Auth: Ocp-Apim-Subscription-Key header (no OAuth).
 * Data: lmp-expost endpoint, preliminaryFinal=Preliminary, 5-min resolution.
 *
 * Required env vars (set in Railway dashboard):
 *   MISO_SUBSCRIPTION_KEY  — from MISO developer portal (data-exchange.misoenergy.org)
 *
 * API note: the developer portal / docs are at data-exchange.misoenergy.org,
 * but the actual runtime API host is apim.misoenergy.org — these are different
 * subdomains. Use apim.misoenergy.org for actual requests.
 *
 * Preliminary vs Final: "Preliminary" returns today's real-time prices as they
 * publish throughout the day. "Final" returns the fully settled ex-post prices
 * from prior days (what GridStatus was serving — stale by days, not minutes).
 */

import { env } from "./env.js";
import { proxyFetch } from "./proxy-fetch.js";

const MISO_API_BASE = "https://apim.misoenergy.org/pricing/v1/real-time";

export interface MisoPollResult {
  ok: boolean;
  intervalStartUtc?: string;
  price?: number;
  error?: string;
}

// ── Helper: YYYYMMDD string for a given Date in Central time ───────────────
// MISO's API uses Central Time dates in the URL path.
function toCentralDateStr(d: Date): string {
  // UTC offset for Central: -5 or -6 depending on DST. Using toLocaleString
  // with timeZone is the safe cross-platform approach.
  const central = new Date(d.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const y = central.getFullYear();
  const m = String(central.getMonth() + 1).padStart(2, "0");
  const dy = String(central.getDate()).padStart(2, "0");
  // MISO API requires YYYY-MM-DD format (not YYYYMMDD).
  return `${y}-${m}-${dy}`;
}

export async function pollMisoIndianaHub(): Promise<MisoPollResult> {
  if (!env.MISO_SUBSCRIPTION_KEY) {
    return { ok: false, error: "MISO_SUBSCRIPTION_KEY not configured" };
  }

  // Try today's date first; if no rows (e.g. early morning before first interval
  // publishes), fall back to yesterday.
  const now = new Date();
  const datesToTry = [toCentralDateStr(now), toCentralDateStr(new Date(now.getTime() - 86400000))];

  for (const dateStr of datesToTry) {
    try {
      const url =
        `${MISO_API_BASE}/${dateStr}/lmp-expost` +
        `?node=INDIANA.HUB&pageNumber=1&preliminaryFinal=Preliminary&timeResolution=5min`;

      // apim.misoenergy.org blocks Railway IPs — route through Cloudflare proxy.
      const res = await proxyFetch(url, {
        headers: {
          "Ocp-Apim-Subscription-Key": env.MISO_SUBSCRIPTION_KEY,
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        },
      });

      if (!res.ok) {
        if (res.status === 404 && dateStr === datesToTry[0]) {
          // Today's file might not exist yet — try yesterday next.
          continue;
        }
        const snippet = (await res.text().catch(() => "")).slice(0, 300);
        return { ok: false, error: `MISO HTTP ${res.status} — ${snippet}` };
      }

      // MISO returns JSON. Shape varies by API version but typically:
      // { "LMPData": [{ "Interval": "HH:MM", "LMP": 45.23, ... }] }
      // or an array directly. Parse defensively.
      const body = (await res.json()) as unknown;

      // Flatten whatever shape MISO returns into an array of price objects.
      let rows: { interval?: string; lmp?: number; LMP?: number; LmpPrice?: number; timestamp?: string }[] = [];
      if (Array.isArray(body)) {
        rows = body as typeof rows;
      } else if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        // Try common wrapper keys.
        const wrapped = b["LMPData"] ?? b["lmpData"] ?? b["data"] ?? b["Data"];
        if (Array.isArray(wrapped)) rows = wrapped as typeof rows;
      }

      if (rows.length === 0) {
        // No rows for this date yet — if it's today, try yesterday.
        if (dateStr === datesToTry[0]) continue;
        return { ok: false, error: `MISO returned no rows for ${dateStr}` };
      }

      // Take the last row (most recent interval).
      const latest = rows[rows.length - 1];
      const price = latest.lmp ?? latest.LMP ?? latest.LmpPrice;
      const interval = latest.interval ?? latest.timestamp;

      if (typeof price !== "number") {
        return {
          ok: false,
          error: `MISO response has unexpected shape. keys=${Object.keys(latest).join(",")}`,
        };
      }

      // Build a UTC timestamp from the date + interval string.
      // MISO interval is usually "HH:MM" in Central time.
      let intervalStartUtc: string;
      if (interval) {
        const [hh, mm] = String(interval).split(":").map(Number);
        // Construct a Central-time Date and convert to UTC ISO string.
        // dateStr is now YYYY-MM-DD, so it can be used directly in an ISO datetime string.
        const centralDate = new Date(
          `${dateStr}T${String(hh ?? 0).padStart(2, "0")}:${String(mm ?? 0).padStart(2, "0")}:00`
        );
        // Approximate Central offset (CST=-6, CDT=-5). Node will adjust if TZ is set.
        intervalStartUtc = centralDate.toISOString();
      } else {
        intervalStartUtc = now.toISOString();
      }

      return { ok: true, intervalStartUtc, price };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  return { ok: false, error: "MISO: no data for today or yesterday" };
}

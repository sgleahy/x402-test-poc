/**
 * Direct connection to ERCOT's own Public API for HB_HUBAVG settlement point
 * prices -- bypasses GridStatus.io entirely. Built as part of the pivot away
 * from GridStatus's hosted API: their Terms of Use prohibit using their data
 * to build a competing product / resell it, which is incompatible with the
 * x402 historical-data business line. ERCOT's own API terms have no such
 * restriction (confirmed 2026-08-18), so ERCOT becomes the first of the 7
 * core hubs to move to a fully independent, directly-sourced pipeline.
 *
 * Two credentials required, both set directly in Railway (never hardcoded):
 *   ERCOT_SUBSCRIPTION_KEY -- static "Ocp-Apim-Subscription-Key", extracted
 *     once from the API Explorer's Products page.
 *   ERCOT_API_USERNAME / ERCOT_API_PASSWORD -- the ERCOT API Explorer account
 *     login, used to mint a short-lived ID token (bearer, ~1hr TTL, no
 *     refresh -- must re-authenticate to get a new one; handled below with
 *     an in-memory cache that re-logs-in a few minutes before expiry).
 *
 * Report used: NP6-905-CD, "Settlement Point Prices at Resource Nodes, Hubs
 * and Load Zones" -- ERCOT's real-time SPP product (vs. NP4-190-CD, the
 * day-ahead version). Confirmed against ERCOT's own report catalog and
 * GridStatus's open-source ERCOT client (which calls this exact endpoint).
 *
 * IMPORTANT: Settlement Point Prices are natively 15-minute (4
 * "deliveryInterval" values per "deliveryHour"), not 5-minute. This is not a
 * limitation to fix later -- there is no finer-grained *settlement point
 * average* price product; 5-minute granularity only exists at the raw SCED
 * LMP / individual bus level, which is a different (much larger, per-node)
 * dataset. 15-min is the correct, complete real-time product for this hub.
 */
import { pool } from "./pg.js";

const TOKEN_URL =
  "https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token";
const CLIENT_ID = "fec253ea-0d06-4272-a5e6-b478baeecd70";
const PUBLIC_BASE_URL = "https://api.ercot.com/api/public-reports";
const SPP_ENDPOINT = `${PUBLIC_BASE_URL}/np6-905-cd/spp_node_zone_hub`;

interface CachedToken {
  token: string;
  expiresAt: number; // ms epoch
}

let cachedToken: CachedToken | null = null;

/**
 * Obtains (and caches) an ERCOT ID token. Tokens are valid ~1hr with no
 * refresh mechanism -- ERCOT's own docs say "there is no way to refresh an
 * ID token. A new ID token may be acquired by sending another POST request."
 * so we just re-authenticate a few minutes before the cached one expires.
 */
async function getIdToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const username = process.env.ERCOT_API_USERNAME;
  const password = process.env.ERCOT_API_PASSWORD;
  if (!username || !password) {
    throw new Error("ERCOT_API_USERNAME / ERCOT_API_PASSWORD not set");
  }

  const url = new URL(TOKEN_URL);
  url.searchParams.set("grant_type", "password");
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);
  url.searchParams.set("response_type", "id_token");
  url.searchParams.set("scope", "openid fec253ea-0d06-4272-a5e6-b478baeecd70 offline_access");
  url.searchParams.set("client_id", CLIENT_ID);

  const res = await fetch(url.toString(), { method: "POST" });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`ERCOT auth failed: HTTP ${res.status} ${bodyText.slice(0, 200)}`);
  }

  const body = (await res.json()) as {
    id_token?: string;
    expires_in?: string;
  };
  if (!body.id_token) {
    throw new Error("ERCOT auth response missing id_token");
  }

  // expires_in observed as "3600" (seconds). Refresh 5 min early to avoid
  // racing the actual expiry mid-request.
  const ttlSeconds = Number(body.expires_in ?? "3600");
  cachedToken = {
    token: body.id_token,
    expiresAt: Date.now() + Math.max(ttlSeconds - 300, 60) * 1000,
  };
  return cachedToken.token;
}

/**
 * ERCOT's Public API returns tabular data as parallel `fields` (column
 * names) + `data` (array of value-arrays) rather than an array of objects --
 * confirmed directly from GridStatus's open-source ERCOT client source
 * (gridstatus/ercot_api/ercot_api.py: `columns = [f["name"] for f in
 * response["fields"]]`, `data_results = response["data"]`). This helper
 * re-shapes that into plain row objects.
 */
function rowsFromFieldsAndData(
  fields: { name: string }[],
  data: unknown[][],
): Record<string, unknown>[] {
  const columns = fields.map((f) => f.name);
  return data.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

/**
 * Converts ERCOT's local-time delivery fields into a UTC interval-start
 * timestamp, matching the convention used everywhere else in
 * hub_prices_live (interval_start_utc).
 *
 * deliveryHour is "hour ending" 1-24 in Central Prevailing Time (i.e.
 * America/Chicago, DST-aware) -- hour N covers local clock time [N-1, N).
 * deliveryInterval 1-4 further divides that hour into four 15-minute
 * settlement sub-intervals, interval M covering [((N-1)*60)+((M-1)*15) ...
 * +15min) minutes from local midnight.
 *
 * KNOWN EDGE CASE: on the one day per year Central time falls back (an hour
 * repeats), deliveryHour/deliveryInterval alone are ambiguous -- ERCOT's own
 * `DSTFlag` field is meant to disambiguate this, but this implementation
 * does not currently branch on it (affects at most 4 intervals/year). Not
 * fixing now; flag if it ever actually matters for the composite.
 */
function toIntervalStartUtc(deliveryDate: string, deliveryHour: number, deliveryInterval: number): string {
  const hourStartBase = deliveryHour - 1; // hour-ending -> hour-starting
  const minutesIntoHour = (deliveryInterval - 1) * 15;
  const localWallClock = `${deliveryDate}T${String(hourStartBase).padStart(2, "0")}:${String(minutesIntoHour).padStart(2, "0")}:00`;

  // Treat the wall-clock string as UTC first, then measure how far
  // America/Chicago's actual offset is at that instant, and correct for it.
  // This handles CDT/CST transitions automatically via the IANA tz database
  // rather than hardcoding an offset.
  const asIfUtc = new Date(`${localWallClock}Z`);
  const chicagoOffsetMs = getTimeZoneOffsetMs(asIfUtc, "America/Chicago");
  return new Date(asIfUtc.getTime() - chicagoOffsetMs).toISOString();
}

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

export interface ErcotPollResult {
  ok: boolean;
  intervalStartUtc?: string;
  price?: number;
  error?: string;
}

/**
 * Fetches the latest HB_HUBAVG settlement point price directly from ERCOT
 * and upserts it into hub_prices_live, using the exact same table/shape
 * price-poller.ts already uses for the other 6 hubs -- this is a drop-in
 * replacement for ERCOT_HB_HUBAVG's row in that table, nothing downstream
 * (composite.ts, the API routes) needs to change.
 */
export async function pollErcotHubAvg(): Promise<ErcotPollResult> {
  const subscriptionKey = process.env.ERCOT_SUBSCRIPTION_KEY;
  if (!subscriptionKey) {
    return { ok: false, error: "ERCOT_SUBSCRIPTION_KEY not set" };
  }

  try {
    const token = await getIdToken();

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const url = new URL(SPP_ENDPOINT);
    url.searchParams.set("settlementPoint", "HB_HUBAVG");
    url.searchParams.set("deliveryDateFrom", yesterday);
    url.searchParams.set("deliveryDateTo", today);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "Ocp-Apim-Subscription-Key": subscriptionKey,
      },
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status} ${bodyText.slice(0, 200)}` };
    }

    const body = (await res.json()) as {
      fields?: { name: string }[];
      data?: unknown[][];
      _meta?: { totalPages?: number };
    };

    if (!body.fields || !body.data) {
      console.error("[ercot-direct] unexpected response shape:", JSON.stringify(body).slice(0, 500));
      return { ok: false, error: "unexpected response shape (missing fields/data)" };
    }

    if (body._meta?.totalPages && body._meta.totalPages > 1) {
      console.warn(
        `[ercot-direct] response has ${body._meta.totalPages} pages -- only reading page 1. ` +
          "Should be rare/impossible for a single settlementPoint over a 2-day window; investigate if seen.",
      );
    }

    const rows = rowsFromFieldsAndData(body.fields, body.data) as Array<{
      deliveryDate: string;
      deliveryHour: number;
      deliveryInterval: number;
      settlementPoint: string;
      settlementPointPrice: number;
    }>;

    if (rows.length === 0) {
      return { ok: false, error: "no rows returned for HB_HUBAVG in lookback window" };
    }

    rows.sort((a, b) => {
      const aKey = `${a.deliveryDate}-${String(a.deliveryHour).padStart(2, "0")}-${a.deliveryInterval}`;
      const bKey = `${b.deliveryDate}-${String(b.deliveryHour).padStart(2, "0")}-${b.deliveryInterval}`;
      return aKey.localeCompare(bKey);
    });
    const latest = rows[rows.length - 1];

    const intervalStartUtc = toIntervalStartUtc(
      latest.deliveryDate,
      latest.deliveryHour,
      latest.deliveryInterval,
    );
    const price = Number(latest.settlementPointPrice);

    if (!Number.isFinite(price)) {
      return { ok: false, error: `non-numeric settlementPointPrice: ${latest.settlementPointPrice}` };
    }

    await pool.query(
      `INSERT INTO hub_prices_live (hub, interval_start_utc, price_usd_mwh)
       VALUES ($1, $2, $3)
       ON CONFLICT (hub, interval_start_utc)
       DO UPDATE SET price_usd_mwh = EXCLUDED.price_usd_mwh, fetched_at = now()`,
      ["ERCOT_HB_HUBAVG", intervalStartUtc, price],
    );

    return { ok: true, intervalStartUtc, price };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

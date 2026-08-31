/**
 * Direct ERCOT connector — polls HB_HUBAVG real-time 15-min SPP from
 * ERCOT's own Public API (api.ercot.com), bypassing GridStatus.io.
 *
 * Auth: OAuth 2.0 ROPC flow via ERCOT's Azure AD B2C tenant.
 * Data: NP6-905-CD report, settlementPoint=HB_HUBAVG, 15-min granularity.
 *
 * Required env vars (set in Railway dashboard):
 *   ERCOT_API_USERNAME      — registered ERCOT API portal username
 *   ERCOT_API_PASSWORD      — registered ERCOT API portal password
 *   ERCOT_SUBSCRIPTION_KEY  — Ocp-Apim-Subscription-Key from portal
 *
 * Known WAF issue: ERCOT's production API uses Akamai bot protection.
 * Railway's shared IPs trigger 403s even with a valid token + sub key.
 * Fix status: added full browser-fingerprint headers (this version).
 * If 403s persist → escalate to Railway Static IP (Pro plan) or proxy.
 */
import { env } from "./env.js";
import { proxyFetch } from "./proxy-fetch.js";

// ── Browser-like headers that Akamai / Cloudflare WAFs expect ──────────────
// Using a realistic Chrome on macOS UA. Without these, Node's default
// "undici" UA string triggers bot-protection challenges instantly.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Ch-Ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
};

// ── ERCOT Azure AD B2C token endpoint ──────────────────────────────────────
// ROPC flow: POST with grant_type=password, username, password.
// Token TTL is ~1 hour. No refresh_token is issued (ROPC limitation).
// We re-auth on every token expiry rather than maintaining a refresh cycle.
const ERCOT_TOKEN_URL =
  "https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token";
// Public client_id confirmed from ERCOT's official API maintainer (github.com/ercot/api-specs #34).
const ERCOT_CLIENT_ID = "fec253ea-0d06-4272-a5e6-b478baeecd70";

const ERCOT_API_BASE = "https://api.ercot.com/api/public-reports";

// ── In-process token cache ──────────────────────────────────────────────────
let cachedToken: string | null = null;
let tokenExpiresAt = 0; // unix ms

async function getErcotToken(): Promise<string> {
  const now = Date.now();
  // Re-use cached token if it has >5 min remaining.
  if (cachedToken && tokenExpiresAt - now > 5 * 60 * 1000) {
    return cachedToken;
  }

  // Build body manually — Microsoft B2C requires scope spaces encoded as "+"
  // not "%20". URLSearchParams may encode them as "%20" depending on runtime.
  // Matching ERCOT's documented example exactly (github.com/ercot/api-specs #34).
  const bodyStr = [
    "grant_type=password",
    `username=${encodeURIComponent(env.ERCOT_API_USERNAME)}`,
    `password=${encodeURIComponent(env.ERCOT_API_PASSWORD)}`,
    `client_id=${ERCOT_CLIENT_ID}`,
    `scope=openid+${ERCOT_CLIENT_ID}+offline_access`,
    "response_type=id_token",
  ].join("&");

  const res = await fetch(ERCOT_TOKEN_URL, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: bodyStr,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ERCOT token request failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("ERCOT token response missing access_token");
  }

  cachedToken = json.access_token;
  // expires_in is in seconds; default to 3600 if missing.
  tokenExpiresAt = now + (json.expires_in ?? 3600) * 1000;
  return cachedToken;
}

// ── Result type shared with price-poller ───────────────────────────────────
export interface ErcotPollResult {
  ok: boolean;
  intervalStartUtc?: string;
  price?: number;
  error?: string;
}

// ── Main poll function ──────────────────────────────────────────────────────
export async function pollErcotHubAvg(): Promise<ErcotPollResult> {
  if (!env.ERCOT_API_USERNAME || !env.ERCOT_API_PASSWORD || !env.ERCOT_SUBSCRIPTION_KEY) {
    return { ok: false, error: "ERCOT credentials not configured (ERCOT_API_USERNAME / ERCOT_API_PASSWORD / ERCOT_SUBSCRIPTION_KEY)" };
  }

  try {
    const token = await getErcotToken();

    // Look back 6 hours (generous for a 15-min feed).
    const now = new Date();
    const from = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    const url = new URL(`${ERCOT_API_BASE}/np6-905-cd`);
    url.searchParams.set("SCEDTimestampFrom", from.toISOString());
    url.searchParams.set("SCEDTimestampTo", now.toISOString());
    url.searchParams.set("settlementPointNames", "HB_HUBAVG");
    url.searchParams.set("size", "100");

    // Data endpoint: api.ercot.com is blocked by Akamai WAF on Railway IPs.
    // Route through Cloudflare Worker proxy — token fetch (Azure B2C) stays direct.
    const res = await proxyFetch(url.toString(), {
      headers: {
        ...BROWSER_HEADERS,
        "Authorization": `Bearer ${token}`,
        "Ocp-Apim-Subscription-Key": env.ERCOT_SUBSCRIPTION_KEY,
      },
    });

    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      // Clear cached token on 401 — stale token, force re-auth next tick.
      if (res.status === 401) cachedToken = null;
      return { ok: false, error: `HTTP ${res.status} ${snippet}` };
    }

    const json = (await res.json()) as { data?: Record<string, unknown>[] };
    const rows = json.data ?? [];

    if (rows.length === 0) {
      return { ok: false, error: "no rows in ERCOT response" };
    }

    // Rows come back ascending by SCEDTimestamp — take the newest.
    const latest = rows[rows.length - 1];
    // ERCOT NP6-905-CD field names (from live API response confirmed in prior session).
    const price = latest["Settlement Point Price"] ?? latest["spp"] ?? latest["price"];
    const tsRaw = latest["SCEDTimestamp"] ?? latest["intervalStartUtc"] ?? latest["timestamp"];

    if (typeof price !== "number" || !tsRaw) {
      return {
        ok: false,
        error: `unexpected ERCOT response fields. keys=${Object.keys(latest).join(",")}`,
      };
    }

    return {
      ok: true,
      intervalStartUtc: String(tsRaw),
      price: price as number,
    };
  } catch (err) {
    // Clear cached token on any network error — might be token-related.
    cachedToken = null;
    return { ok: false, error: (err as Error).message };
  }
}

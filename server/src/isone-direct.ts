/**
 * Direct ISO-NE connector — polls Internal Hub real-time hourly LMP
 * from ISO-NE's Web Services API, bypassing GridStatus.io.
 *
 * Auth: HTTP Basic Auth (username + password from isoexpress.iso-ne.com account).
 * Data: Real-time hourly LMP, .H.INTERNAL_HUB (the Mass Hub / internal pricing node).
 *
 * Required env vars (set in Railway dashboard):
 *   ISONE_USERNAME  — registered isoexpress.iso-ne.com username
 *   ISONE_PASSWORD  — registered isoexpress.iso-ne.com password
 *
 * Registration: https://isoexpress.iso-ne.com (free account)
 * API docs:     https://webservices.iso-ne.com/docs/doc.html
 *
 * Note: ISO-NE's API may or may not block Railway IPs. If this connector
 * returns "fetch failed", route through the Cloudflare Worker proxy the same
 * way MISO and NYISO are handled.
 */

import { env } from "./env.js";

const ISONE_API_BASE = "https://webservices.iso-ne.com/api/v1.1";
const ISONE_HUB_NAME = ".H.INTERNAL_HUB";

export interface IsonePollResult {
  ok: boolean;
  intervalStartUtc?: string;
  price?: number;
  error?: string;
}

// ── ISO-NE date helper (Eastern time, YYYYMMDD) ────────────────────────────
function toEasternDateStr(d: Date): string {
  const eastern = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = eastern.getFullYear();
  const m = String(eastern.getMonth() + 1).padStart(2, "0");
  const dy = String(eastern.getDate()).padStart(2, "0");
  return `${y}${m}${dy}`;
}

// ── Auth header ─────────────────────────────────────────────────────────────
function basicAuthHeader(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

// ── JSON shape returned by ISO-NE web services ─────────────────────────────
// ISO-NE wraps responses in a specific envelope. Two common shapes:
//
// Shape A (current endpoint): { "HourlyLmps": { "HourlyLmp": [...] } }
// Shape B (day endpoint):     { "HourlyLmps": { "HourlyLmp": [...] } }
//
// Each row: {
//   "BeginDate":            "2024-01-15T14:00:00.000-05:00",
//   "Location":             { "@LocId": "4001", "$": ".H.INTERNAL_HUB" },
//   "LmpTotal":             45.23,
//   "EnergyComponent":      40.00,
//   "CongestionComponent":   5.23,
//   "LossComponent":        -0.00
// }
interface IsoneHourlyLmpRow {
  BeginDate?: string;
  Location?: { "@LocId"?: string; "$"?: string } | string;
  LmpTotal?: number;
  EnergyComponent?: number;
  CongestionComponent?: number;
  LossComponent?: number;
}

function extractRows(body: unknown): IsoneHourlyLmpRow[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;

  // Unwrap the outer envelope.
  const outer = b["HourlyLmps"] ?? b["hourlylmps"];
  if (!outer || typeof outer !== "object") return [];

  const inner = (outer as Record<string, unknown>)["HourlyLmp"] ??
                (outer as Record<string, unknown>)["hourlylmp"];
  if (Array.isArray(inner)) return inner as IsoneHourlyLmpRow[];
  if (inner && typeof inner === "object") return [inner as IsoneHourlyLmpRow];
  return [];
}

function getLocationName(row: IsoneHourlyLmpRow): string {
  if (typeof row.Location === "string") return row.Location;
  if (row.Location && typeof row.Location === "object") {
    return row.Location["$"] ?? row.Location["@LocId"] ?? "";
  }
  return "";
}

// ── Main poll function ──────────────────────────────────────────────────────
export async function pollIsoneInternalHub(): Promise<IsonePollResult> {
  if (!env.ISONE_USERNAME || !env.ISONE_PASSWORD) {
    return { ok: false, error: "ISONE_USERNAME / ISONE_PASSWORD not configured" };
  }

  const authHeader = basicAuthHeader(env.ISONE_USERNAME, env.ISONE_PASSWORD);
  const now = new Date();

  // Strategy: try the /current endpoint first (most recent hour, all locations).
  // If that fails or returns no hub data, fall back to today's full-day endpoint,
  // then yesterday's.
  const endpoints = [
    `${ISONE_API_BASE}/hourlylmp/rt/current`,
    `${ISONE_API_BASE}/hourlylmp/rt/final/day/${toEasternDateStr(now)}`,
    `${ISONE_API_BASE}/hourlylmp/rt/preliminary/day/${toEasternDateStr(now)}`,
    `${ISONE_API_BASE}/hourlylmp/rt/final/day/${toEasternDateStr(new Date(now.getTime() - 86400000))}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          "Authorization": authHeader,
          "Accept": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        },
      });

      if (!res.ok) {
        // 401 = bad credentials, 403 = account issue — don't retry other endpoints.
        if (res.status === 401 || res.status === 403) {
          const snippet = (await res.text().catch(() => "")).slice(0, 200);
          return {
            ok: false,
            error: `ISO-NE HTTP ${res.status} — check ISONE_USERNAME/ISONE_PASSWORD. Detail: ${snippet}`,
          };
        }
        // 404 = no data for this date (e.g., final not published yet) — try next endpoint.
        continue;
      }

      const body = await res.json() as unknown;
      const rows = extractRows(body);

      // Filter to our target hub.
      const hubRows = rows.filter((r) => {
        const name = getLocationName(r).toUpperCase();
        return name.includes("INTERNAL_HUB") || name.includes("INTERNAL HUB");
      });

      if (hubRows.length === 0) {
        // No hub data from this endpoint — try next.
        continue;
      }

      // Sort by BeginDate descending and take the most recent.
      hubRows.sort((a, b) => {
        const ta = a.BeginDate ? new Date(a.BeginDate).getTime() : 0;
        const tb = b.BeginDate ? new Date(b.BeginDate).getTime() : 0;
        return tb - ta;
      });

      const latest = hubRows[0];
      const price = latest.LmpTotal;

      if (typeof price !== "number") {
        return {
          ok: false,
          error: `ISO-NE: LmpTotal missing. Row keys: ${Object.keys(latest).join(",")}`,
        };
      }

      // BeginDate is ISO 8601 with Eastern offset — parse directly.
      const intervalStartUtc = latest.BeginDate
        ? new Date(latest.BeginDate).toISOString()
        : now.toISOString();

      return { ok: true, intervalStartUtc, price };
    } catch (err) {
      // Network error — if the current endpoint returns fetch failed, try next.
      const msg = (err as Error).message;
      if (msg === "fetch failed" && url !== endpoints[endpoints.length - 1]) {
        continue;
      }
      return { ok: false, error: msg };
    }
  }

  return { ok: false, error: "ISO-NE: no data found across all endpoints" };
}

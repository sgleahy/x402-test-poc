/**
 * Direct NYISO connector — polls Zone J (N.Y.C.) day-ahead LMP from NYISO's
 * own public data portal, bypassing GridStatus.io.
 *
 * Auth: None. NYISO publishes CSV files publicly at mis.nyiso.com.
 * Data: Day-ahead zonal LMP ($/MWh), hourly, Zone J = "N.Y.C."
 *
 * CSV URL pattern:
 *   https://mis.nyiso.com/public/csv/damlbmp/{YYYYMMDD}damlbmp_zone.csv
 *
 * CSV format (header row):
 *   Timestamp,Name,LBMP ($/MWHr),Marginal Cost Losses ($/MWHr),Marginal Cost Congestion ($/MWHr)
 *
 * NYISO publishes day-ahead prices around 11 AM ET the prior day for the
 * full following operating day (hours 1-24). So today's file always has all
 * 24 hours of prices from ~11 AM yesterday onward. maxLagHours: 48 in hubs.ts
 * correctly covers this — the price is "stale" in the sense that it's for
 * the current trading hour, not a real-time measurement.
 */

export interface NyisoPollResult {
  ok: boolean;
  intervalStartUtc?: string;
  price?: number;
  error?: string;
}

const NYISO_BASE = "https://mis.nyiso.com/public/csv/damlbmp";
const TARGET_ZONE = "N.Y.C.";

// ── Helper: YYYYMMDD string in Eastern time ─────────────────────────────────
function toEasternDateStr(d: Date): string {
  const eastern = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = eastern.getFullYear();
  const m = String(eastern.getMonth() + 1).padStart(2, "0");
  const dy = String(eastern.getDate()).padStart(2, "0");
  return `${y}${m}${dy}`;
}

// ── Minimal CSV parser (no external dependency) ─────────────────────────────
// Handles quoted fields. NYISO CSVs are well-formed so this stays simple.
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
  });
}

export async function pollNyisoZoneJ(): Promise<NyisoPollResult> {
  // Try today first, then yesterday (in case today's file isn't published yet).
  const now = new Date();
  const datesToTry = [toEasternDateStr(now), toEasternDateStr(new Date(now.getTime() - 86400000))];

  for (const dateStr of datesToTry) {
    try {
      const url = `${NYISO_BASE}/${dateStr}damlbmp_zone.csv`;

      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept": "text/csv, text/plain, */*",
        },
      });

      if (!res.ok) {
        if (res.status === 404 && dateStr === datesToTry[0]) {
          // Today's file not published yet — try yesterday.
          continue;
        }
        return { ok: false, error: `NYISO HTTP ${res.status} for ${dateStr}` };
      }

      const text = await res.text();
      const rows = parseCsv(text);

      // Filter to Zone J only.
      const zoneRows = rows.filter((r) => {
        const name = r["Name"] ?? r["name"] ?? "";
        return name.trim() === TARGET_ZONE;
      });

      if (zoneRows.length === 0) {
        if (dateStr === datesToTry[0]) continue;
        return { ok: false, error: `NYISO: no ${TARGET_ZONE} rows in ${dateStr}` };
      }

      // Find the row closest to (but not after) now.
      // NYISO timestamps are Eastern time, format: "MM/DD/YYYY HH:MM:SS"
      const nowMs = now.getTime();
      let bestRow: Record<string, string> | null = null;
      let bestMs = 0;

      for (const row of zoneRows) {
        const tsRaw = row["Timestamp"] ?? row["timestamp"] ?? "";
        if (!tsRaw) continue;
        // Parse "MM/DD/YYYY HH:MM:SS" as Eastern time.
        // Simplest approach: replace / and : and let Date parse it.
        const parts = tsRaw.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)/);
        if (!parts) continue;
        const [, mo, dy, yr, hh, mm, ss] = parts;
        // Build an ISO string and treat as Eastern (approximate — NYISO is ET, UTC-5/4).
        const isoStr = `${yr}-${mo.padStart(2, "0")}-${dy.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:${ss.padStart(2, "0")}`;
        const eastern = new Date(isoStr + (isDst(now) ? "-04:00" : "-05:00"));
        const ms = eastern.getTime();
        if (ms <= nowMs && ms > bestMs) {
          bestMs = ms;
          bestRow = row;
        }
      }

      // If no row is before "now" (e.g. very early morning, today's file only has future hours)
      // fall back to the last row in the file.
      if (!bestRow) {
        bestRow = zoneRows[zoneRows.length - 1];
        const tsRaw = bestRow["Timestamp"] ?? "";
        const parts = tsRaw.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)/);
        if (parts) {
          const [, mo, dy, yr, hh, mm, ss] = parts;
          const isoStr = `${yr}-${mo.padStart(2, "0")}-${dy.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:${ss.padStart(2, "0")}`;
          bestMs = new Date(isoStr + (isDst(now) ? "-04:00" : "-05:00")).getTime();
        }
      }

      const lbmpRaw = bestRow["LBMP ($/MWHr)"] ?? bestRow["lbmp"] ?? bestRow["price"];
      const price = parseFloat(String(lbmpRaw));

      if (isNaN(price)) {
        return { ok: false, error: `NYISO: could not parse price from "${lbmpRaw}"` };
      }

      const tsRaw = bestRow["Timestamp"] ?? "";
      const parts = tsRaw.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)/);
      let intervalStartUtc = now.toISOString();
      if (parts) {
        const [, mo, dy, yr, hh, mm, ss] = parts;
        const isoStr = `${yr}-${mo.padStart(2, "0")}-${dy.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:${ss.padStart(2, "0")}`;
        intervalStartUtc = new Date(isoStr + (isDst(now) ? "-04:00" : "-05:00")).toISOString();
      }

      return { ok: true, intervalStartUtc, price };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  return { ok: false, error: "NYISO: no data found for today or yesterday" };
}

// ── Very approximate DST check (US Eastern) ─────────────────────────────────
// DST: second Sunday of March → first Sunday of November.
// Good enough for our purposes — off by at most an hour on transition days,
// which only affects timestamp display, not the price value.
function isDst(d: Date): boolean {
  const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(d.getFullYear(), 6, 1).getTimezoneOffset();
  return d.getTimezoneOffset() < Math.max(jan, jul);
}

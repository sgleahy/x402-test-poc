/**
 * Direct SPP connector — polls SPPSOUTH_HUB real-time 5-min LMP
 * from SPP's public Marketplace portal, bypassing GridStatus.io.
 *
 * Auth: None. SPP's file browser API is fully public.
 * Data: RTBM (Real-Time Balancing Market) LMP by Settlement Location.
 *       5-minute intervals. Hub: SPPSOUTH_HUB.
 *
 * SPP publishes a "latestInterval" CSV that always points to the most
 * recent 5-min RTBM result — no date arithmetic or directory walking needed.
 *
 * API reference:
 *   https://portal.spp.org/pages/rtbm-lmp-by-location
 *   File: RTBM-LMP-SL-latestInterval.csv
 *
 * CSV columns:
 *   GMTIntervalEnd   — UTC timestamp of interval END (subtract 5 min → start)
 *   Settlement Location — pnode name (we filter for SPPSOUTH_HUB)
 *   LMP              — total LMP $/MWh
 *   MLC              — marginal loss component
 *   MCC              — marginal congestion component
 *   MEC              — marginal energy component
 *
 * Note: SPP portal does not use Akamai WAF — direct fetch works from Railway.
 * No proxy needed.
 */

const SPP_LATEST_URL =
  "https://portal.spp.org/file-browser-api/download/rtbm-lmp-by-location?path=%2FRTBM-LMP-SL-latestInterval.csv";

const SPP_HUB = "SPPSOUTH_HUB";

export interface SppPollResult {
  ok: boolean;
  intervalStartUtc?: string;
  price?: number;
  error?: string;
}

// ── Minimal CSV parser ────────────────────────────────────────────────────────
// Parses a CSV string into an array of objects keyed by header row.
// Handles quoted fields with commas. Good enough for well-formed SPP CSV.
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    if (values.length === 0) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (values[idx] ?? "").trim();
    });
    rows.push(row);
  }

  return rows;
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ── Main poll function ────────────────────────────────────────────────────────
export async function pollSppSouthHub(): Promise<SppPollResult> {
  try {
    const res = await fetch(SPP_LATEST_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "text/csv,text/plain,*/*",
      },
    });

    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, error: `SPP portal HTTP ${res.status} — ${snippet}` };
    }

    const text = await res.text();

    if (!text || text.trim().length === 0) {
      return { ok: false, error: "SPP returned empty response" };
    }

    // Detect non-CSV responses (e.g. HTML error pages).
    if (text.trimStart().startsWith("<")) {
      return { ok: false, error: "SPP returned HTML instead of CSV — portal may be down" };
    }

    const rows = parseCsv(text);

    if (rows.length === 0) {
      return { ok: false, error: "SPP CSV parsed to zero rows" };
    }

    // Find our hub row.
    const hubRow = rows.find((r) => r["Settlement Location"] === SPP_HUB);

    if (!hubRow) {
      // Log what hubs were available for debugging.
      const seen = [...new Set(rows.map((r) => r["Settlement Location"]).filter(Boolean))].slice(0, 10);
      return {
        ok: false,
        error: `SPP CSV has no row for ${SPP_HUB}. Settlement Locations seen: ${seen.join(", ")}`,
      };
    }

    const lmpStr = hubRow["LMP"];
    const gmtEnd = hubRow["GMTIntervalEnd"];

    if (!lmpStr || !gmtEnd) {
      return {
        ok: false,
        error: `SPP row for ${SPP_HUB} is missing LMP or GMTIntervalEnd. Row: ${JSON.stringify(hubRow)}`,
      };
    }

    const price = parseFloat(lmpStr);
    if (isNaN(price)) {
      return { ok: false, error: `SPP LMP value not a number: "${lmpStr}"` };
    }

    // GMTIntervalEnd is the END of the 5-min interval. Subtract 5 min → interval start.
    // SPP format is typically "MM/DD/YYYY HH:MM:SS" in UTC.
    const endDate = new Date(gmtEnd);
    if (isNaN(endDate.getTime())) {
      return { ok: false, error: `SPP GMTIntervalEnd not parseable: "${gmtEnd}"` };
    }

    const intervalStartUtc = new Date(endDate.getTime() - 5 * 60 * 1000).toISOString();

    return { ok: true, intervalStartUtc, price };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

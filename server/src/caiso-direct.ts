/**
 * Direct CAISO connector — polls NP15 hub RTM (Real-Time Market)
 * 5-min LMP from CAISO's public OASIS API, bypassing GridStatus.io.
 *
 * Auth: None. CAISO OASIS is fully public.
 * Data: PRC_INTVL_LMP query, 5-min resolution, TH_NP15_GEN-APND (N. California).
 *
 * CAISO OASIS returns a ZIP file containing XML. This connector:
 *   1. Fetches the ZIP (binary) — processed in-memory, never written to disk
 *   2. Extracts the XML using Node.js built-in zlib + manual ZIP parsing
 *   3. Parses the XML with lightweight regex (no external library needed)
 *   4. After each poll, asynchronously spot-checks 3 random intervals from
 *      the last 15 stored intervals to detect CAISO price revisions and keep
 *      our database current. ZIP files are never persisted to disk.
 *
 * API reference: https://www.caiso.com/documents/oasis-frequently-asked-questions.pdf
 * SingleZip endpoint: https://oasis.caiso.com/oasisapi/SingleZip
 *
 * Note: CAISO OASIS does not use Akamai WAF — direct fetch works from Railway.
 * No proxy needed.
 */

import { pool } from "./pg.js";

const CAISO_OASIS = "https://oasis.caiso.com/oasisapi/SingleZip";
const NP15_NODE = "TH_NP15_GEN-APND";
const HUB = "CAISO_NP15";

// CAISO rate limit: ~1 request per 5 seconds per IP.
// Used between spot-check re-fetches to avoid throttling.
const CAISO_REQUEST_DELAY_MS = 5500;

// Number of recent intervals to pull for spot-checking, and how many to re-verify.
const SPOT_CHECK_POOL = 15;
const SPOT_CHECK_COUNT = 3;

export interface CaisoPollResult {
  ok: boolean;
  intervalStartUtc?: string;
  price?: number;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// CAISO expects UTC timestamps in YYYYMMDDTHH:MM-0000 format.
function toCaisoDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}${mo}${dy}T${hh}:${mm}-0000`;
}

// ── Minimal ZIP extractor (uses only Node.js built-ins) ──────────────────────
// CAISO's ZIP files are standard deflate ZIPs. We extract the first entry's
// raw bytes without an external library by reading the local file header.
//
// ZIP local file header layout (§4.3.7 of the ZIP spec):
//   Offset  Length  Contents
//   0       4       Local file header signature = 0x04034b50
//   4       2       Version needed
//   6       2       General purpose bit flag
//   8       2       Compression method (0=store, 8=deflate)
//   10      2       Last mod file time
//   12      2       Last mod file date
//   14      4       CRC-32
//   18      4       Compressed size
//   22      4       Uncompressed size
//   26      2       Filename length (n)
//   28      2       Extra field length (m)
//   30      n       Filename
//   30+n    m       Extra field
//   30+n+m  ...     File data (compressed)
async function extractFirstZipEntry(zipBuffer: Buffer): Promise<string> {
  if (zipBuffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("Not a ZIP file (bad PK signature)");
  }

  const compressionMethod = zipBuffer.readUInt16LE(8);
  const filenameLen = zipBuffer.readUInt16LE(26);
  const extraLen = zipBuffer.readUInt16LE(28);
  const dataOffset = 30 + filenameLen + extraLen;

  if (compressionMethod === 0) {
    // Stored (no compression) — size is reliable in local header for non-streaming ZIPs.
    const compressedSize = zipBuffer.readUInt32LE(18);
    if (compressedSize === 0) return "";
    return zipBuffer.subarray(dataOffset, dataOffset + compressedSize).toString("utf8");
  }

  if (compressionMethod === 8) {
    const { inflateRaw } = await import("node:zlib");
    const { promisify } = await import("node:util");
    const inflateRawAsync = promisify(inflateRaw);
    // CAISO uses streaming ZIP generators that set bit 3 in the general-purpose
    // flag, meaning the local file header stores compressedSize = 0 (the real
    // size appears in a data descriptor AFTER the compressed data). Passing only
    // compressedData bytes causes "unexpected end of file" because we get 0 bytes.
    // Fix: pass everything from the data start to the end of the buffer. inflateRaw
    // knows when the deflate stream ends internally and ignores any trailing bytes
    // (the data descriptor, the next entry's header, etc.).
    const compressedData = zipBuffer.subarray(dataOffset);
    if (compressedData.length === 0) return "";
    const decompressed = await inflateRawAsync(compressedData);
    return decompressed.toString("utf8");
  }

  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

// ── Minimal XML value extractor ───────────────────────────────────────────────
function xmlText(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
  return m?.[1]?.trim();
}

// ── CAISO RTM XML parser ──────────────────────────────────────────────────────
// RTM (PRC_INTVL_LMP) uses DATA_ITEM=LMP_PRC for total LMP.
// RTPD (PRC_RTPD_LMP) used DATA_ITEM=INTERVAL_LMP.
// We accept both plus the no-underscore variant to be resilient.
const ACCEPTED_DATA_ITEMS = new Set(["LMP_PRC", "INTERVAL_LMP", "INTERVALLMP"]);

interface OasisRow {
  intervalNum: number;
  oprDate: string;
  value: number;
}

function parseOasisXml(xml: string): OasisRow[] {
  const results: OasisRow[] = [];
  const blockRe = /<REPORT_DATA>([\s\S]*?)<\/REPORT_DATA>/g;
  let match: RegExpExecArray | null;

  while ((match = blockRe.exec(xml)) !== null) {
    const block = match[1];

    const dataItem = xmlText(block, "DATA_ITEM") ?? xmlText(block, "data_item");
    const resourceName = xmlText(block, "RESOURCE_NAME") ?? xmlText(block, "resource_name");
    const oprDate = xmlText(block, "OPR_DATE") ?? xmlText(block, "opr_date");
    const intervalNumStr = xmlText(block, "INTERVAL_NUM") ?? xmlText(block, "interval_num");
    const valueStr = xmlText(block, "VALUE") ?? xmlText(block, "value");

    if (
      dataItem !== undefined &&
      ACCEPTED_DATA_ITEMS.has(dataItem) &&
      resourceName === NP15_NODE &&
      oprDate &&
      intervalNumStr &&
      valueStr
    ) {
      const intervalNum = parseInt(intervalNumStr, 10);
      const value = parseFloat(valueStr);
      if (!isNaN(intervalNum) && !isNaN(value)) {
        results.push({ intervalNum, oprDate, value });
      }
    }
  }

  return results;
}

// ── CAISO RTM interval → UTC timestamp ───────────────────────────────────────
// RTM has 288 intervals per day (5-min each):
//   interval 1   = 00:00 PPT
//   interval 288 = 23:55 PPT
// Pacific offset: PDT (Mar–Nov) = UTC-7, PST (Nov–Mar) = UTC-8.
function caisoIntervalToUtc(oprDate: string, intervalNum: number, referenceDate: Date): Date {
  const month = referenceDate.getUTCMonth() + 1; // 1–12
  const isDst = month >= 3 && month <= 11;
  const utcOffsetHours = isDst ? 7 : 8;

  const minuteOfDay = (intervalNum - 1) * 5; // 5-min intervals (was 15 for RTPD)
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;

  const year = parseInt(oprDate.slice(0, 4), 10);
  const month2 = parseInt(oprDate.slice(4, 6), 10) - 1; // 0-indexed
  const day = parseInt(oprDate.slice(6, 8), 10);

  return new Date(Date.UTC(year, month2, day, hour + utcOffsetHours, minute));
}

// ── Shared fetch-and-parse helper ─────────────────────────────────────────────
// Queries CAISO OASIS for the given UTC window, returns parsed RTM rows.
// All ZIP processing happens in memory — nothing is written to disk.
async function fetchCaisoWindow(from: Date, to: Date): Promise<{ rows: OasisRow[]; error?: string }> {
  const url = new URL(CAISO_OASIS);
  url.searchParams.set("queryname", "PRC_INTVL_LMP");  // 5-min RTM (was PRC_RTPD_LMP)
  url.searchParams.set("market_run_id", "RTM");          // was RTPD
  url.searchParams.set("node", NP15_NODE);
  url.searchParams.set("startdatetime", toCaisoDateStr(from));
  url.searchParams.set("enddatetime", toCaisoDateStr(to));
  url.searchParams.set("version", "1");

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      Accept: "*/*",
    },
  });

  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 300);
    return { rows: [], error: `CAISO OASIS HTTP ${res.status} — ${snippet}` };
  }

  const arrayBuf = await res.arrayBuffer();
  const zipBuffer = Buffer.from(arrayBuf);

  let xml: string;
  try {
    xml = await extractFirstZipEntry(zipBuffer);
  } catch (e) {
    return { rows: [], error: `ZIP extract failed: ${(e as Error).message}` };
  }

  if (xml.includes("<ERR_CODE>") || xml.includes("INVALID_REQUEST")) {
    const errCode = xmlText(xml, "ERR_CODE") ?? "unknown";
    const errMsg = xmlText(xml, "ERR_DESC") ?? xmlText(xml, "MESSAGE") ?? xml.slice(0, 200);
    return { rows: [], error: `CAISO API error ${errCode}: ${errMsg}` };
  }

  const rows = parseOasisXml(xml);

  // Debug: if we got XML but no rows matched, log distinct DATA_ITEM values seen.
  if (rows.length === 0) {
    const dataItems = [...xml.matchAll(/<DATA_ITEM[^>]*>([^<]*)<\/DATA_ITEM>/g)].map((m) => m[1]);
    const unique = [...new Set(dataItems)];
    if (unique.length > 0) {
      console.warn(
        `[caiso] No rows matched — DATA_ITEM values seen in response: ${unique.join(", ")}. ` +
          `Accepted: ${[...ACCEPTED_DATA_ITEMS].join(", ")}.`
      );
    }
  }

  return { rows };
}

// ── Main poll function ────────────────────────────────────────────────────────
export async function pollCaisoNp15(): Promise<CaisoPollResult> {
  try {
    const now = new Date();
    // Fetch 90 min back — RTM publishes ~10 min after interval close, so
    // the most recent confirmed interval may be 1–3 intervals behind real-time.
    const from = new Date(now.getTime() - 90 * 60 * 1000);

    const { rows, error } = await fetchCaisoWindow(from, now);

    if (error) return { ok: false, error };

    if (rows.length === 0) {
      return {
        ok: false,
        error: `CAISO returned no RTM LMP rows for ${NP15_NODE} in the past 90 minutes`,
      };
    }

    // Sort descending by (oprDate, intervalNum) — take the latest confirmed interval.
    rows.sort((a, b) => {
      if (a.oprDate !== b.oprDate) return b.oprDate.localeCompare(a.oprDate);
      return b.intervalNum - a.intervalNum;
    });

    const latest = rows[0];
    const intervalStartUtc = caisoIntervalToUtc(latest.oprDate, latest.intervalNum, now).toISOString();

    return { ok: true, intervalStartUtc, price: latest.value };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ── Spot-check: verify 3 random intervals from the last 15 ───────────────────
// Call this AFTER writing the latest poll result to the database. Run without
// awaiting (fire-and-forget) so it does not block the main poll cycle.
//
// CAISO sometimes revises interval prices after initial publication. This
// function re-downloads 3 random recent intervals from CAISO and compares
// them to what we stored. If a revision is found, we update hub_prices_live.
//
// ZIP files are fetched, processed in memory, and discarded — nothing is
// written to disk at any point.
export async function spotCheckCaisoHistory(): Promise<void> {
  try {
    // 1. Pull the last SPOT_CHECK_POOL intervals from our database.
    const dbResult = await pool.query<{ interval_start_utc: string; price_usd_mwh: number }>(
      `SELECT interval_start_utc, price_usd_mwh
       FROM hub_prices_live
       WHERE hub = $1
       ORDER BY interval_start_utc DESC
       LIMIT $2`,
      [HUB, SPOT_CHECK_POOL]
    );

    const stored = dbResult.rows;
    if (stored.length < 2) {
      // Not enough history yet — skip.
      return;
    }

    // 2. Randomly pick SPOT_CHECK_COUNT intervals to re-verify.
    const shuffled = [...stored].sort(() => Math.random() - 0.5);
    const toCheck = shuffled.slice(0, Math.min(SPOT_CHECK_COUNT, shuffled.length));

    console.log(
      `[caiso spot-check] Re-verifying ${toCheck.length} of ${stored.length} recent intervals...`
    );

    let revisionsFound = 0;

    for (let i = 0; i < toCheck.length; i++) {
      if (i > 0) {
        // Respect CAISO's rate limit between requests.
        await sleep(CAISO_REQUEST_DELAY_MS);
      }

      const row = toCheck[i];
      const intervalStart = new Date(row.interval_start_utc);
      // Query a 10-minute window centered on this interval to ensure we capture it.
      const windowStart = new Date(intervalStart.getTime() - 5 * 60 * 1000);
      const windowEnd = new Date(intervalStart.getTime() + 5 * 60 * 1000);

      let rows: OasisRow[];
      try {
        const result = await fetchCaisoWindow(windowStart, windowEnd);
        if (result.error) {
          console.warn(`[caiso spot-check] Fetch error for ${row.interval_start_utc}: ${result.error}`);
          continue;
        }
        rows = result.rows;
      } catch (err) {
        console.warn(`[caiso spot-check] Exception for ${row.interval_start_utc}: ${(err as Error).message}`);
        continue;
      }

      if (rows.length === 0) {
        console.warn(`[caiso spot-check] No data returned for window around ${row.interval_start_utc}`);
        continue;
      }

      // Find the row whose UTC timestamp matches our stored interval.
      const now = new Date();
      const matchedRows = rows.filter((r) => {
        const rowUtc = caisoIntervalToUtc(r.oprDate, r.intervalNum, now);
        return Math.abs(rowUtc.getTime() - intervalStart.getTime()) < 5 * 60 * 1000; // within 5 min
      });

      if (matchedRows.length === 0) {
        console.warn(`[caiso spot-check] Could not match interval ${row.interval_start_utc} in CAISO response`);
        continue;
      }

      // Use the most recent matching row (CAISO may return multiple versions).
      matchedRows.sort((a, b) => b.intervalNum - a.intervalNum);
      const caiso = matchedRows[0];
      const caisoPriceCurrent = caiso.value;
      const dbPrice = Number(row.price_usd_mwh);

      const delta = Math.abs(caisoPriceCurrent - dbPrice);
      if (delta > 0.01) {
        // CAISO has revised this interval — update our database.
        revisionsFound++;
        console.log(
          `[caiso spot-check] REVISION detected at ${row.interval_start_utc}: ` +
            `stored=${dbPrice.toFixed(2)}, CAISO now=${caisoPriceCurrent.toFixed(2)} (Δ${delta.toFixed(2)})`
        );
        try {
          await pool.query(
            `UPDATE hub_prices_live
             SET price_usd_mwh = $1, fetched_at = now()
             WHERE hub = $2 AND interval_start_utc = $3`,
            [caisoPriceCurrent, HUB, row.interval_start_utc]
          );
        } catch (dbErr) {
          console.error(`[caiso spot-check] DB update failed:`, dbErr);
        }
      }
    }

    console.log(
      `[caiso spot-check] Complete — ${revisionsFound} revision(s) found and corrected.`
    );
  } catch (err) {
    // Spot-check is best-effort — never let it propagate.
    console.error(`[caiso spot-check] Unexpected error:`, err);
  }
}

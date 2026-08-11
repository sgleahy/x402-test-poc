/**
 * Read-only access to the ERCOT HB_HUBAVG test dataset (SQLite).
 * Uses Node's built-in node:sqlite (DatabaseSync) — no native module
 * compilation required, which matters in sandboxed/offline build environments.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, env.DB_PATH);

export interface HubAvgRow {
  interval_start_utc: string;
  interval_end_utc: string;
  location: string;
  market: string;
  price_usd_mwh: number;
}

function openDb(): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function getAllHubAvgRows(): HubAvgRow[] {
  const db = openDb();
  try {
    const stmt = db.prepare(
      "SELECT interval_start_utc, interval_end_utc, location, market, price_usd_mwh " +
        "FROM ercot_hubavg_prices ORDER BY interval_start_utc ASC",
    );
    return stmt.all() as unknown as HubAvgRow[];
  } finally {
    db.close();
  }
}

export function getRowCount(): number {
  const db = openDb();
  try {
    const stmt = db.prepare("SELECT COUNT(*) as count FROM ercot_hubavg_prices");
    const row = stmt.get() as unknown as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

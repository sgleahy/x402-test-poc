/**
 * Runs the Postgres schema migration on every boot. Safe to run repeatedly:
 * migrations/001_init.sql uses CREATE TABLE/INDEX IF NOT EXISTS throughout.
 *
 * This exists so deploying doesn't depend on anyone having psql access or a
 * plaintext DATABASE_URL -- Railway's MCP token deliberately redacts actual
 * credential values, so "run this SQL file once by hand" isn't a reliable
 * step to depend on. The server just makes sure its own schema exists
 * before it starts polling/serving.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pg.js";
import { env } from "./env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  if (!env.DATABASE_URL) {
    console.warn("[migrate] DATABASE_URL not set, skipping schema migration");
    return;
  }
  const sqlPath = path.resolve(__dirname, "../migrations/001_init.sql");
  const sql = fs.readFileSync(sqlPath, "utf-8");
  try {
    await pool.query(sql);
    console.log("[migrate] schema migration applied (or already up to date)");
  } catch (err) {
    console.error("[migrate] FAILED:", (err as Error).message);
    throw err;
  }
}

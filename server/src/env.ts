/**
 * Central place for reading and validating environment variables.
 *
 * IMPORTANT: this module must NOT throw at import time if CDP credentials
 * are still placeholder values. The server should boot and answer
 * unauthenticated routes (e.g. /api/test/status) even before real CDP
 * credentials are supplied. Payment-gated routes fail lazily instead.
 */
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  PORT: Number(process.env.PORT ?? 3402),
  PAY_TO_ADDRESS: process.env.PAY_TO_ADDRESS ?? "",
  JWT_SECRET: process.env.JWT_SECRET ?? "",
  CDP_API_KEY_ID: process.env.CDP_API_KEY_ID ?? "",
  CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET ?? "",
  DB_PATH: process.env.DB_PATH ?? "../../ercot_hubavg_test.db",
  // ── Live $ELEC composite (added for the load-weighted production build) ──
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  GRIDSTATUS_API_KEY: process.env.GRIDSTATUS_API_KEY ?? "",
  POLL_INTERVAL_MINUTES: Number(process.env.POLL_INTERVAL_MINUTES ?? 15),
};

export function requireDatabaseUrl(): string {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured (Railway sets this automatically once a Postgres plugin is attached to this service)");
  }
  return env.DATABASE_URL;
}

export function requireGridstatusApiKey(): string {
  if (!env.GRIDSTATUS_API_KEY) {
    throw new Error("GRIDSTATUS_API_KEY is not configured in .env");
  }
  return env.GRIDSTATUS_API_KEY;
}

/** Placeholder sentinel values written to .env before real CDP creds exist. */
const CDP_PLACEHOLDERS = new Set([
  "",
  "REPLACE_ME_CDP_API_KEY_ID",
  "REPLACE_ME_CDP_API_KEY_SECRET",
  "your_cdp_api_key_id_here",
  "your_cdp_api_key_secret_here",
]);

export function hasRealCdpCredentials(): boolean {
  return (
    !CDP_PLACEHOLDERS.has(env.CDP_API_KEY_ID) &&
    !CDP_PLACEHOLDERS.has(env.CDP_API_KEY_SECRET)
  );
}

/** Throws only when actually needed (i.e. when a payment-gated request comes in). */
export function requireCdpCredentials(): { apiKeyId: string; apiKeySecret: string } {
  if (!hasRealCdpCredentials()) {
    throw new Error(
      "CDP_API_KEY_ID / CDP_API_KEY_SECRET are not configured yet. " +
        "Replace the placeholder values in .env with real CDP API credentials " +
        "before calling a payment-gated route.",
    );
  }
  return { apiKeyId: required("CDP_API_KEY_ID"), apiKeySecret: required("CDP_API_KEY_SECRET") };
}

export function requireJwtSecret(): string {
  if (!env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured in .env");
  }
  return env.JWT_SECRET;
}

export function requirePayToAddress(): string {
  if (!env.PAY_TO_ADDRESS) {
    throw new Error("PAY_TO_ADDRESS is not configured in .env");
  }
  return env.PAY_TO_ADDRESS;
}

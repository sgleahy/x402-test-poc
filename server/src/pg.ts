/**
 * Postgres connection pool. Railway injects DATABASE_URL automatically when
 * a Postgres plugin is attached to this service in the same project.
 */
import pg from "pg";
import { env } from "./env.js";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

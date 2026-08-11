import { Router } from "express";
import { requireSessionToken } from "../auth-middleware.js";
import { getAllHubAvgRows, getRowCount } from "../db.js";
import { issueSessionToken } from "../jwt.js";

export const testRouter = Router();

/**
 * GET /api/test/status — unauthenticated health check.
 */
testRouter.get("/status", (_req, res) => {
  try {
    const rows_available = getRowCount();
    res.json({ status: "ok", rows_available });
  } catch (err) {
    res.status(500).json({ status: "error", error: (err as Error).message });
  }
});

/**
 * POST /api/test/access — payment-gated (x402 middleware runs before this
 * handler; see index.ts). By the time we get here, payment has already been
 * verified for this request. Issue a 1-hour session JWT.
 */
testRouter.post("/access", (req, res) => {
  // The x402 middleware attaches payment details to the request when available.
  const payer = (req as unknown as { x402?: { payer?: string } }).x402?.payer;
  const { token, expires_at } = issueSessionToken(payer);
  res.json({ token, expires_at });
});

/**
 * GET /api/test/data — protected by session JWT (Authorization: Bearer or ?token=).
 * Returns all ERCOT HB_HUBAVG rows.
 */
testRouter.get("/data", requireSessionToken, (_req, res) => {
  try {
    const rows = getAllHubAvgRows();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

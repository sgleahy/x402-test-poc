import { Router } from "express";
import { requireSessionToken } from "../auth-middleware.js";
import { issueSessionToken } from "../jwt.js";
import { getLatestComposite, getCompositeHistory } from "../composite.js";

export const elecRouter = Router();

/**
 * GET /api/elec/status — unauthenticated health check. Reports how fresh
 * the latest composite is, not just that the process is up.
 */
elecRouter.get("/status", async (_req, res) => {
  try {
    const latest = await getLatestComposite();
    if (!latest) {
      res.json({ status: "ok", composite_available: false });
      return;
    }
    const ageMinutes = (Date.now() - new Date(latest.hourUtc).getTime()) / 60000;
    res.json({
      status: "ok",
      composite_available: true,
      latest_hour_utc: latest.hourUtc,
      age_minutes: Math.round(ageMinutes),
      n_hubs_available: latest.nHubsAvailable,
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: (err as Error).message });
  }
});

/**
 * POST /api/elec/access — payment-gated (x402 middleware runs before this
 * handler; see index.ts). Issues a 1-hour session JWT, same pattern as the
 * original /api/test/access POC route.
 */
elecRouter.post("/access", (req, res) => {
  const payer = (req as unknown as { x402?: { payer?: string } }).x402?.payer;
  const { token, expires_at } = issueSessionToken(payer);
  res.json({ token, expires_at });
});

/**
 * GET /api/elec/latest — JWT-protected. Returns the current $ELEC price
 * (load-weighted, winsorized composite across the 7 hubs) plus a per-hub
 * breakdown for auditability.
 */
elecRouter.get("/latest", requireSessionToken, async (_req, res) => {
  try {
    const latest = await getLatestComposite();
    if (!latest) {
      res.status(503).json({ error: "no composite data available yet" });
      return;
    }
    res.json({
      hour_utc: latest.hourUtc,
      elec_price_usd_mwh: latest.elecPrice,
      n_hubs_available: latest.nHubsAvailable,
      n_hubs_capped: latest.nHubsCapped,
      hubs: latest.detail,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/elec/history?hours=24 — JWT-protected. Returns the composite
 * series for the trailing N hours (default 24, max 720 = 30 days).
 */
elecRouter.get("/history", requireSessionToken, async (req, res) => {
  try {
    const hoursParam = Number(req.query.hours ?? 24);
    const hours = Number.isFinite(hoursParam) ? Math.min(Math.max(hoursParam, 1), 720) : 24;
    const history = await getCompositeHistory(hours);
    res.json(
      history.map((row) => ({
        hour_utc: row.hourUtc,
        elec_price_usd_mwh: row.elecPrice,
        n_hubs_available: row.nHubsAvailable,
        n_hubs_capped: row.nHubsCapped,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

import express from "express";
import { paymentMiddleware } from "@x402/express";
import { env, requirePayToAddress } from "./env.js";
import { resourceServer, ensureFacilitatorReady, BASE_MAINNET_NETWORK } from "./facilitator.js";
import { testRouter } from "./routes/test.js";
import { elecRouter } from "./routes/elec.js";
import { startScheduler } from "./scheduler.js";

const app = express();
app.use(express.json());

// Guard in front of the x402 middleware: lazily initializes the facilitator
// connection (fetches supported payment kinds from CDP) on the first real
// payment-gated request. If CDP_API_KEY_ID/CDP_API_KEY_SECRET are still
// placeholders, this returns a clean 503 with an actionable message instead
// of a raw stack trace or (worse) crashing the whole process at startup.
async function facilitatorGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    await ensureFacilitatorReady();
    next();
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
}
app.post("/api/test/access", facilitatorGuard);
app.post("/api/elec/access", facilitatorGuard);

// x402 payment gate. syncFacilitatorOnStart is explicitly false: the default
// (true) would call the CDP facilitator at process startup, which would
// throw if CDP creds are still placeholders. The facilitatorGuard above
// handles initialization lazily instead, so the server always boots cleanly
// regardless of .env state.
//
// /api/test/access is the original ERCOT-only proof-of-concept route, kept
// for reference. /api/elec/access is the real product: the live 7-hub
// load-weighted composite.
app.use(
  paymentMiddleware(
    {
      "POST /api/test/access": {
        accepts: {
          scheme: "exact",
          price: "$0.05",
          network: BASE_MAINNET_NETWORK,
          payTo: requirePayToAddress(),
          maxTimeoutSeconds: 60,
        },
        description: "$ELEC x402 test session — 1 hour access to ERCOT HB_HUBAVG test dataset",
      },
      "POST /api/elec/access": {
        accepts: {
          scheme: "exact",
          price: "$0.05",
          network: BASE_MAINNET_NETWORK,
          payTo: requirePayToAddress(),
          maxTimeoutSeconds: 60,
        },
        description: "$ELEC — 1 hour access to the live 7-hub load-weighted US electricity price composite",
      },
    },
    resourceServer,
    undefined,
    undefined,
    false, // syncFacilitatorOnStart
  ),
);

app.use("/api/test", testRouter);
app.use("/api/elec", elecRouter);

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`$ELEC server listening on port ${env.PORT}`);
  console.log(`  GET  /api/elec/status   (unauthenticated)`);
  console.log(`  POST /api/elec/access   (x402 payment-gated, $0.05 USDC on Base mainnet)`);
  console.log(`  GET  /api/elec/latest   (JWT-protected)`);
  console.log(`  GET  /api/elec/history  (JWT-protected)`);
  console.log(`  --- legacy POC routes still mounted at /api/test/* ---`);
});

// Starts the price-poll + composite-recompute loop (see scheduler.ts).
// Safe to call even if DATABASE_URL/GRIDSTATUS_API_KEY aren't set yet --
// individual ticks log and skip rather than crashing the process.
startScheduler();

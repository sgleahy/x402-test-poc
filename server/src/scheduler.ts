/**
 * Simple in-process poll loop -- no external cron needed. Railway keeps this
 * service running continuously, so setInterval is sufficient for v1. Runs
 * once immediately on boot, then every POLL_INTERVAL_MINUTES.
 *
 * The load-poller (../load-poller, a separate Python service/deploy) writes
 * to the same Postgres independently on its own schedule -- this loop only
 * handles price polling + recomputing the composite from whatever price/load
 * data is currently in the DB.
 */
import { pollLatestPrices } from "./price-poller.js";
import { computeAndStoreLatestComposite } from "./composite.js";
import { env } from "./env.js";

let running = false;

async function tick(): Promise<void> {
  if (running) {
    console.log("[scheduler] previous tick still running, skipping");
    return;
  }
  running = true;
  try {
    const priceResults = await pollLatestPrices();
    const failed = priceResults.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.warn("[scheduler] price poll issues:", failed);
    }
    const composite = await computeAndStoreLatestComposite();
    if (composite) {
      console.log(
        `[scheduler] composite updated: hour=${composite.hourUtc} price=$${composite.elecPrice.toFixed(2)} ` +
          `hubs=${composite.nHubsAvailable}/7 capped=${composite.nHubsCapped}`,
      );
    } else {
      console.warn("[scheduler] no composite computed (no valid hub data yet)");
    }
  } catch (err) {
    console.error("[scheduler] tick failed:", err);
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  const intervalMs = env.POLL_INTERVAL_MINUTES * 60 * 1000;
  console.log(`[scheduler] starting, poll interval = ${env.POLL_INTERVAL_MINUTES} min`);
  void tick();
  setInterval(() => void tick(), intervalMs);
}

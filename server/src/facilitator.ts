/**
 * CDP facilitator wiring for the x402 resource server.
 *
 * Uses the @x402/* package family (current/recommended as of the July 2026
 * x402 docs — see README.md for how this was verified), configured against
 * Coinbase's CDP facilitator on Base MAINNET (CAIP-2 network id "eip155:8453").
 *
 * CDP API requests are authenticated with a per-request JWT built from
 * CDP_API_KEY_ID / CDP_API_KEY_SECRET via @coinbase/cdp-sdk/auth's
 * getAuthHeaders() helper (the same helper CDP's own SDKs use for every
 * other CDP Platform API). Nothing in this module touches the network or
 * validates credentials at import time — see ensureFacilitatorReady() below,
 * which is called lazily, only when a payment-gated request actually comes in.
 */
import { getAuthHeaders } from "@coinbase/cdp-sdk/auth";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { hasRealCdpCredentials, requireCdpCredentials } from "./env.js";

export const BASE_MAINNET_NETWORK = "eip155:8453";

const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const CDP_FACILITATOR_HOST = "api.cdp.coinbase.com";

async function buildAuthHeadersFor(requestPath: string, requestMethod: string) {
  const { apiKeyId, apiKeySecret } = requireCdpCredentials();
  return getAuthHeaders({
    apiKeyId,
    apiKeySecret,
    requestMethod,
    requestHost: CDP_FACILITATOR_HOST,
    requestPath,
    source: "elec-x402-test-poc",
    sourceVersion: "0.1.0",
  });
}

const facilitatorClient = new HTTPFacilitatorClient({
  url: CDP_FACILITATOR_URL,
  createAuthHeaders: async () => ({
    verify: await buildAuthHeadersFor("/platform/v2/x402/verify", "POST"),
    settle: await buildAuthHeadersFor("/platform/v2/x402/settle", "POST"),
    supported: await buildAuthHeadersFor("/platform/v2/x402/supported", "GET"),
  }),
});

export const resourceServer = new x402ResourceServer(facilitatorClient).register(
  BASE_MAINNET_NETWORK,
  new ExactEvmScheme(),
);

let initialized = false;

/**
 * Lazily calls resourceServer.initialize() (which fetches supported payment
 * kinds from the CDP facilitator) the first time a payment-gated request
 * actually needs it. Throws a clear, actionable error if CDP credentials are
 * still placeholders instead of letting a raw network/auth error bubble up.
 */
export async function ensureFacilitatorReady(): Promise<void> {
  if (initialized) return;
  if (!hasRealCdpCredentials()) {
    throw new Error(
      "CDP_API_KEY_ID / CDP_API_KEY_SECRET are not configured yet. " +
        "Replace the placeholder values in .env with real CDP API credentials " +
        "before the x402 payment flow can talk to the CDP facilitator.",
    );
  }
  await resourceServer.initialize();
  initialized = true;
}

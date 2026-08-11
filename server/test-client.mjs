/**
 * $ELEC x402 test POC — live payment client.
 *
 * Runs on YOUR machine only. Reads your wallet's private key from .env
 * (EVM_PRIVATE_KEY) — that key never gets sent anywhere except signed
 * locally by viem and used to construct the on-chain payment. It is never
 * transmitted to Claude or anywhere else.
 *
 * What this does:
 *   1. Calls POST /api/test/access. The x402 fetch wrapper automatically
 *      catches the 402 challenge, signs a $0.05 USDC payment on Base
 *      mainnet with your account, and retries the request with payment
 *      attached.
 *   2. Prints the session token you got back.
 *   3. Calls GET /api/test/data with that token and prints the result
 *      (should be all 287 ERCOT HB_HUBAVG rows).
 *
 * Run with:
 *   node test-client.mjs
 */
import "dotenv/config";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const SERVER_URL = process.env.TEST_SERVER_URL ?? "http://localhost:3402";

const { EVM_PRIVATE_KEY } = process.env;

if (!EVM_PRIVATE_KEY || EVM_PRIVATE_KEY.startsWith("REPLACE_ME")) {
  console.error(
    "\nEVM_PRIVATE_KEY is not set in .env yet.\n" +
      "Open .env in this folder and replace the EVM_PRIVATE_KEY placeholder\n" +
      "with your wallet's real private key (starts with 0x, 64 hex characters\n" +
      "after the 0x). This must be the private key for the wallet you funded\n" +
      "with a small amount of real USDC on Base mainnet.\n",
  );
  process.exit(1);
}

const account = privateKeyToAccount(EVM_PRIVATE_KEY);
console.log(`Using wallet: ${account.address}`);

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: "eip155:8453", // Base mainnet
      client: new ExactEvmScheme(account),
    },
  ],
});

console.log(`\n1. Requesting access (this will trigger a real $0.05 USDC payment)...`);

const accessRes = await fetchWithPayment(`${SERVER_URL}/api/test/access`, {
  method: "POST",
});

if (!accessRes.ok) {
  console.error(`Access request failed: ${accessRes.status} ${accessRes.statusText}`);
  console.error(await accessRes.text());
  process.exit(1);
}

const { token, expires_at } = await accessRes.json();
console.log(`   Got session token, expires at ${expires_at}`);

const paymentResponseHeader = accessRes.headers.get("PAYMENT-RESPONSE");
if (paymentResponseHeader) {
  console.log(`   Payment settled:`, decodePaymentResponseHeader(paymentResponseHeader));
}

console.log(`\n2. Fetching ERCOT HB_HUBAVG data with the session token...`);

const dataRes = await fetch(`${SERVER_URL}/api/test/data?token=${token}`);
const data = await dataRes.json();

console.log(`   Got ${Array.isArray(data) ? data.length : "?"} rows. First 3:`);
console.log(Array.isArray(data) ? data.slice(0, 3) : data);

console.log(
  `\nDone. Check https://basescan.org/address/${account.address} to confirm the ` +
    `$0.05 USDC payment landed at 0xbD7965EABc8E3143f61c6c06132A90fD01e651e1.`,
);

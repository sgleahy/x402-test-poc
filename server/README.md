# $ELEC x402 test POC

A small proof-of-concept API server that gates access to a real dataset
(ERCOT `HB_HUBAVG` real-time price data, 287 rows) behind the [x402 payment
protocol](https://github.com/coinbase/x402) — HTTP 402 + a USDC-on-Base
micropayment — end to end.

**This is a scoped test, not production.** It runs on **Base MAINNET** with
real USDC (not testnet) — a deliberate choice by the project owner, since the
per-session cost is trivial ($0.05). Do not point this at production data or
expose it publicly without a security review.

## What it does

1. `POST /api/test/access` (unauthenticated, but x402-payment-gated) —
   triggers the x402 flow for **$0.05 USDC / 1-hour session** on Base
   mainnet, paid to `0xbD7965EABc8E3143f61c6c06132A90fD01e651e1`, verified via
   the Coinbase CDP facilitator. On success, returns a signed JWT
   (`{ token, expires_at }`) valid for 1 hour.
2. `GET /api/test/data` (JWT-protected via `Authorization: Bearer <token>` or
   `?token=`) — returns all 287 rows of ERCOT `HB_HUBAVG` price data as JSON.
3. `GET /api/test/status` (unauthenticated) — health check:
   `{ status: "ok", rows_available: 287 }`.

## Packages used (verified, not guessed)

This uses the **`@x402/*` scoped package family**
(`@x402/express@2.18.0`, `@x402/core@2.18.0`, `@x402/evm@2.18.0`), which is
the actively maintained, current package as of this build (published days
before this project was built, vs. the legacy `x402-express@1.2.0`, last
published ~3 months prior and explicitly documented as superseded — see the
"Migration from x402-express" section of the `@x402/express` README).

Verification method: installed the real packages from npm and read their
actual shipped `README.md` / `.d.ts` files rather than guessing at the API
surface — see `@x402/express`'s Quick Start and "Custom Facilitator Client"
sections for the exact `paymentMiddleware` / `x402ResourceServer` /
`HTTPFacilitatorClient` shape used in `src/index.ts` and `src/facilitator.ts`.
Base mainnet is addressed via its CAIP-2 id, `eip155:8453`, per the current
package's network format (the legacy package used the plain string
`"base"`).

CDP facilitator auth (`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`) is implemented
using `getAuthHeaders()` from `@coinbase/cdp-sdk/auth` — the same JWT-signing
helper CDP's own SDKs use for every other CDP Platform API call — wired into
`HTTPFacilitatorClient`'s `createAuthHeaders` callback in
`src/facilitator.ts`. This part could not be tested live (no real CDP
credentials yet — see below), so treat the exact `verify`/`settle`/`supported`
sub-paths as best-effort pending a live test.

## Setup

```bash
npm install
```

Fill in the two missing values in `.env` (already gitignored; a real
`PAY_TO_ADDRESS` and a freshly generated `JWT_SECRET` are already in there):

```
CDP_API_KEY_ID=REPLACE_ME_CDP_API_KEY_ID
CDP_API_KEY_SECRET=REPLACE_ME_CDP_API_KEY_SECRET
```

Get real values from https://portal.cdp.coinbase.com/ under "API Keys". The
server **will boot fine with the placeholder values** — it only fails (with a
clean `503` JSON error, not a crash) when someone actually calls
`POST /api/test/access`.

Run it:

```bash
npm run dev     # tsx watch, TypeScript directly
# or
npm run build && npm start   # compiled JS
```

Check it's alive:

```bash
curl http://localhost:3402/api/test/status
# {"status":"ok","rows_available":287}
```

## Testing the full payment flow

Once real CDP credentials are in `.env`, and you have a wallet funded with a
small amount of real USDC on Base mainnet:

### Option A — `x402-fetch` client (recommended, does the payment for you)

```bash
npm install x402-fetch viem
```

```js
// test-client.mjs
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount("0xYOUR_PRIVATE_KEY"); // funded with real USDC on Base
const fetchWithPayment = wrapFetchWithPayment(fetch, account);

const res = await fetchWithPayment("http://localhost:3402/api/test/access", {
  method: "POST",
});
const { token, expires_at } = await res.json();
console.log("session token:", token, "expires:", expires_at);

const dataRes = await fetch(`http://localhost:3402/api/test/data?token=${token}`);
console.log(await dataRes.json());
```

```bash
node test-client.mjs
```

`x402-fetch` (or the newer `@x402/fetch`) automatically catches the 402
response, signs and submits the USDC payment on Base, retries the request
with the payment payload attached, and returns the final response.

### Option B — manual curl (to see the raw 402 challenge)

```bash
# 1. See the payment challenge (no payment attached yet):
curl -i -X POST http://localhost:3402/api/test/access
# → HTTP/1.1 402 Payment Required, body describes the $0.05 USDC / Base
#   mainnet payment requirements (scheme, network, payTo, asset, etc.)

# 2. A real client must then construct and sign an EIP-3009 USDC transfer
#    authorization matching those requirements and resend the request with an
#    X-PAYMENT header containing the signed payload. This part requires a
#    real wallet/private key and is impractical to do by hand with curl —
#    use Option A for an actual live test.
```

## Deviations from spec

- Used Node's built-in `node:sqlite` (`DatabaseSync`) instead of
  `better-sqlite3` — this sandbox's build environment can't compile native
  Node addons (no network access for `node-gyp` headers), and `node:sqlite`
  is available natively in Node 22 with no native compilation required. It
  emits a one-line "experimental feature" warning on startup; functionally
  equivalent for this read-only use case.
- Added a small `ensureFacilitatorReady()` guard (`src/facilitator.ts`,
  called from `src/index.ts`) in front of the x402 middleware. The
  `@x402/express` `paymentMiddleware` normally calls the facilitator at
  startup (`syncFacilitatorOnStart`, default `true`), which would crash the
  process immediately with placeholder CDP credentials. This POC sets that
  flag to `false` and instead lazily calls `resourceServer.initialize()` on
  the *first actual payment-gated request*, returning a clean `503` JSON
  error if credentials are still placeholders — this satisfies the "must not
  crash at import-time" requirement more precisely than the package's default
  behavior would.

## What you (the project owner) need to do next

1. Get a CDP API key pair from https://portal.cdp.coinbase.com/.
2. Put the real `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` into `.env` at
   `x402-test-poc/server/.env` (replacing the two `REPLACE_ME_...` values).
3. Fund a wallet with a small amount of real USDC on Base mainnet (a few
   cents is enough for several $0.05 test sessions) plus a trace of ETH for
   gas if the payment scheme requires it.
4. Run `npm install && npm run dev` from `x402-test-poc/server/`.
5. Run the Option A client script above (or your own x402 client) against
   `http://localhost:3402/api/test/access` to trigger a real payment, confirm
   you get back a token, and confirm `GET /api/test/data` returns the 287
   ERCOT rows using that token.
6. Watch the $0.05 USDC land at `0xbD7965EABc8E3143f61c6c06132A90fD01e651e1`
   on a Base block explorer to confirm settlement.

/**
 * proxyFetch — drop-in replacement for fetch() that routes through the
 * Cloudflare Worker proxy when PROXY_URL + PROXY_SECRET are configured.
 *
 * Why: Railway's shared outbound IPs are blocked by ERCOT (Akamai WAF),
 * MISO, and NYISO. Cloudflare Worker IPs are not on those blocklists.
 *
 * Usage: replace `fetch(url, options)` with `proxyFetch(url, options)` in
 * ercot-direct.ts (data endpoint only), miso-direct.ts, and nyiso-direct.ts.
 *
 * Without proxy configured (local dev): calls fetch() directly — no change.
 * With proxy configured (Railway production): routes through the Worker.
 *
 * Railway env vars required (set in Railway dashboard → server-gz9R → Variables):
 *   PROXY_URL     = https://elec-iso-proxy.<your-subdomain>.workers.dev
 *   PROXY_SECRET  = (same secret you set in Cloudflare with `wrangler secret put`)
 */
import { env } from "./env.js";

export async function proxyFetch(url: string, options?: RequestInit): Promise<Response> {
  if (!env.PROXY_URL || !env.PROXY_SECRET) {
    // No proxy configured — call ISO directly.
    // Works fine in local dev; will fail from Railway for blocked ISOs.
    return fetch(url, options);
  }

  // Build the forwarded request: same method/headers/body, but sent to the
  // Cloudflare Worker URL. The Worker reads X-Target-URL and forwards there.
  const headers = new Headers((options?.headers ?? {}) as Record<string, string>);
  headers.set("X-Target-URL", url);
  headers.set("X-Proxy-Secret", env.PROXY_SECRET);

  return fetch(env.PROXY_URL, {
    ...options,
    headers,
  });
}

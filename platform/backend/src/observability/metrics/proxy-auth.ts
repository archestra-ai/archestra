/**
 * Prometheus metrics for the LLM proxy's pre-request auth throttling.
 *
 * The proxy relays a provider's own 429 verbatim, so a 429 seen by a client is
 * ambiguous between "the provider throttled you" and "we did". This counter
 * separates the second case out, and names which bucket closed:
 *
 * Requests we throttled in the last 5m, by bucket:
 * sum by (bucket) (rate(llm_proxy_auth_rate_limited_total[5m]))
 */

import client from "prom-client";
import logger from "@/logging";

let authRateLimitedTotal: client.Counter<string>;

let initialized = false;

export function initializeProxyAuthMetrics(): void {
  if (initialized) return;
  initialized = true;

  authRateLimitedTotal = new client.Counter({
    name: "llm_proxy_auth_rate_limited_total",
    help: "Total LLM proxy requests rejected by the virtual-key failure limiter, by the bucket that closed",
    labelNames: ["bucket"],
  });

  logger.info("LLM proxy auth metrics initialized");
}

export function reportVirtualKeyRateLimited(params: {
  /** `credential` = the (IP, credential) bucket; `ip` = the IP-wide backstop. */
  bucket: "credential" | "ip";
}): void {
  if (!authRateLimitedTotal) return;
  authRateLimitedTotal.inc({ bucket: params.bucket });
}

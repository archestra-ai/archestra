import { type AllowedCacheKey, CacheKey } from "@/cache-manager";
import { ApiError } from "@/types";
import { isRateLimitExceeded, isRateLimited } from "@/utils/rate-limit";

/**
 * Per-IP throttle on FAILED A2A authentication attempts (missing or invalid
 * bearer token), shared by the v1 and v2 A2A routes. Only failures count, so
 * legitimate high-volume callers are never throttled; an IP that keeps failing
 * auth (token brute force, endpoint scanning) is answered with 429 before any
 * token-validation work runs.
 */
export async function assertA2AAuthNotRateLimited(
  clientIp: string,
): Promise<void> {
  if (await isRateLimitExceeded(cacheKeyFor(clientIp), RATE_LIMIT)) {
    throw new ApiError(429, "Too many failed authentication attempts");
  }
}

/** Count one failed authentication attempt against the caller's IP. */
export async function recordA2AAuthFailure(clientIp: string): Promise<void> {
  await isRateLimited(cacheKeyFor(clientIp), RATE_LIMIT);
}

// =============================================================================
// Internal
// =============================================================================

const RATE_LIMIT = {
  windowMs: 60_000,
  maxRequests: 10,
};

function cacheKeyFor(clientIp: string): AllowedCacheKey {
  return `${CacheKey.A2AAuthFailureRateLimit}-${clientIp || "unknown"}`;
}

import { type AllowedCacheKey, cacheManager } from "@/cache-manager";

/**
 * Rate limit entry stored in cache.
 * @deprecated Internal shape — do not use outside of tests/mocks.
 */
export interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Rate limit window in milliseconds */
  windowMs: number;
  /** Maximum requests allowed per window */
  maxRequests: number;
}

/**
 * Check if an identifier (e.g., IP address) is rate limited using the shared CacheManager.
 * Uses a fixed window algorithm with configurable window size and max requests.
 *
 * The check-and-increment is performed atomically via a database transaction
 * (SELECT FOR UPDATE) so concurrent requests cannot bypass the limit through
 * a non-atomic read-modify-write race.
 *
 * @param cacheKey - The cache key to use for storing rate limit state
 * @param config - Rate limit configuration (windowMs, maxRequests)
 * @returns true if rate limited, false otherwise
 *
 * @example
 * ```ts
 * const cacheKey = `${CacheKey.WebhookRateLimit}-${clientIp}` as AllowedCacheKey;
 * if (await isRateLimited(cacheKey, { windowMs: 60_000, maxRequests: 60 })) {
 *   return reply.status(429).send({ error: "Too many requests" });
 * }
 * ```
 */
export async function isRateLimited(
  cacheKey: AllowedCacheKey,
  config: RateLimitConfig,
): Promise<boolean> {
  return cacheManager.atomicRateLimit(cacheKey, config);
}

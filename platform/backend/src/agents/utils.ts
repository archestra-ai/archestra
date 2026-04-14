import { type AllowedCacheKey, cacheManager } from "@/cache-manager";
import { sql } from "drizzle-orm";
import db from "@/database";

/**
 * Rate limit entry stored in cache
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
 * Atomically increment the rate limit counter for a given key.
 *
 * Uses PostgreSQL's INSERT ... ON CONFLICT to perform an atomic upsert:
 * - If the key doesn't exist or the window has expired, creates a new entry with count=1
 * - If the key exists and the window is still valid, increments the count atomically
 *
 * Returns the current count after the operation.
 *
 * This eliminates the TOCTOU race condition in the previous get+set implementation,
 * where concurrent requests could read the same counter value before any of them
 * wrote back the incremented value, allowing more requests through than intended.
 */
async function atomicIncrementRateLimit(
  cacheKey: AllowedCacheKey,
  windowMs: number,
): Promise<{ count: number; windowStart: number }> {
  const now = Date.now();
  const expiresAt = now + windowMs * 2; // TTL is 2x window
  const keyvKey = `keyv:${cacheKey}`;

  // Keyv stores values as JSON strings with {value, expires} structure
  const newEntry = JSON.stringify({
    value: { count: 1, windowStart: now },
    expires: expiresAt,
  });

  // Use raw SQL for atomic upsert with conditional increment
  // If the row doesn\'t exist or the window has expired (windowStart <= threshold),
  // insert a new entry with count=1.
  // Otherwise, atomically increment the existing count.
  const threshold = now - windowMs;
  const result = await db.execute<{
    raw_value: string;
  }>(
    sql\`INSERT INTO keyv_cache (key, value)
         VALUES (\${keyvKey}, \${newEntry})
         ON CONFLICT (key) DO UPDATE SET
           value = CASE
             WHEN (keyv_cache.value::jsonb->>'value')::jsonb->>'windowStart' IS NULL
               OR ((keyv_cache.value::jsonb->>'value')::jsonb->>'windowStart')::bigint <= \${threshold}
             THEN \${newEntry}
             ELSE jsonb_build_object(
               'value', jsonb_build_object(
                 'count', (((keyv_cache.value::jsonb->>'value')::jsonb->>'count')::int + 1),
                 'windowStart', ((keyv_cache.value::jsonb->>'value')::jsonb->>'windowStart')::bigint
               ),
               'expires', \${expiresAt}
             )::text
           END
         RETURNING value\`,
  );

  if (result.rows.length === 0) {
    // Fallback: return count=1 (shouldn\'t happen with ON CONFLICT)
    return { count: 1, windowStart: now };
  }

  const rawValue = result.rows[0].raw_value;
  const parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
  return parsed.value as { count: number; windowStart: number };
}

/**
 * Check if an identifier (e.g., IP address) is rate limited using the shared CacheManager.
 * Uses a sliding window algorithm with configurable window size and max requests.
 *
 * The implementation uses an atomic database upsert to prevent race conditions
 * under concurrent requests. The previous get+set pattern allowed multiple requests
 * to read the same counter before any wrote back the incremented value.
 *
 * @param cacheKey - The cache key to use for storing rate limit state
 * @param config - Rate limit configuration (windowMs, maxRequests)
 * @returns true if rate limited, false otherwise
 *
 * @example
 * \`\`\`ts
 * const cacheKey = \`\${CacheKey.WebhookRateLimit}-\${clientIp}\` as AllowedCacheKey;
 * if (await isRateLimited(cacheKey, { windowMs: 60_000, maxRequests: 60 })) {
 *   return reply.status(429).send({ error: "Too many requests" });
 * }
 * \`\`\`
 */
export async function isRateLimited(
  cacheKey: AllowedCacheKey,
  config: RateLimitConfig,
): Promise<boolean> {
  const { windowMs, maxRequests } = config;

  const { count } = await atomicIncrementRateLimit(cacheKey, windowMs);

  // count was already incremented atomically, so compare with maxRequests + 1
  // (the first request sets count=1, so count > maxRequests means rate limited)
  return count > maxRequests;
}

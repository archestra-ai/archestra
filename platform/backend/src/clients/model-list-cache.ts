import type { SupportedProvider } from "@shared";
import logger from "@/logging";

/**
 * In-memory cache for LLM provider model lists.
 *
 * This cache stores the available models for each provider to avoid
 * frequent API calls. Models change infrequently, so a 12-hour TTL
 * is appropriate.
 *
 * The cache is keyed by provider and organizationId since different
 * organizations may have different API keys with access to different models.
 */

export interface CachedModel {
  id: string;
  displayName: string;
  provider: SupportedProvider;
  createdAt?: string;
}

interface ModelCacheEntry {
  models: CachedModel[];
  timestamp: number;
}

const MODEL_CACHE = new Map<string, ModelCacheEntry>();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Generate a cache key from provider and organization ID
 */
function getCacheKey(
  provider: SupportedProvider,
  organizationId: string,
): string {
  return `${provider}:${organizationId}`;
}

/**
 * Store models in cache for a provider
 */
export function cacheModels(
  provider: SupportedProvider,
  organizationId: string,
  models: CachedModel[],
): void {
  const key = getCacheKey(provider, organizationId);
  logger.debug(
    { provider, organizationId, modelCount: models.length },
    "[modelListCache] Caching models",
  );
  MODEL_CACHE.set(key, {
    models,
    timestamp: Date.now(),
  });
}

/**
 * Retrieve cached models for a provider
 * Returns null if no entry exists or if the entry has expired
 */
export function getCachedModels(
  provider: SupportedProvider,
  organizationId: string,
): CachedModel[] | null {
  const key = getCacheKey(provider, organizationId);
  const entry = MODEL_CACHE.get(key);

  if (!entry) {
    logger.debug(
      { provider, organizationId },
      "[modelListCache] No cached models found",
    );
    return null;
  }

  // Check if expired
  const age = Date.now() - entry.timestamp;
  if (age > CACHE_TTL_MS) {
    logger.debug(
      { provider, organizationId, ageMs: age, ttlMs: CACHE_TTL_MS },
      "[modelListCache] Cached models expired",
    );
    MODEL_CACHE.delete(key);
    return null;
  }

  logger.debug(
    { provider, organizationId, modelCount: entry.models.length, ageMs: age },
    "[modelListCache] Retrieved valid cached models",
  );

  return entry.models;
}

/**
 * Invalidate cache for a specific provider and organization
 */
export function invalidateCache(
  provider: SupportedProvider,
  organizationId: string,
): void {
  const key = getCacheKey(provider, organizationId);
  MODEL_CACHE.delete(key);
  logger.debug(
    { provider, organizationId },
    "[modelListCache] Invalidated cache",
  );
}

/**
 * Invalidate all cached models for an organization
 */
export function invalidateOrganizationCache(organizationId: string): void {
  for (const key of MODEL_CACHE.keys()) {
    if (key.endsWith(`:${organizationId}`)) {
      MODEL_CACHE.delete(key);
    }
  }
  logger.debug(
    { organizationId },
    "[modelListCache] Invalidated all caches for organization",
  );
}

/**
 * Clean up expired cache entries.
 * Call periodically to prevent memory leaks.
 */
export function cleanupExpiredEntries(): void {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of MODEL_CACHE.entries()) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      MODEL_CACHE.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug(
      { cleanedEntries: cleaned, remainingEntries: MODEL_CACHE.size },
      "[modelListCache] Cleaned expired entries",
    );
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredEntries, 5 * 60 * 1000);

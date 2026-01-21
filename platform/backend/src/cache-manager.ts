import { TimeInMs } from "@shared";
import { createCache, type Cache } from "cache-manager";
import config from "@/config";
import logger from "@/logging";
import { postgresCacheStore } from "@/postgres-cache-store";

/**
 * Unified cache manager that supports both in-memory and distributed (PostgreSQL) caching.
 *
 * Modes:
 * - In-memory (default): Fast, single-pod only. Ideal for quickstart/development.
 * - PostgreSQL: Distributed across pods. Required for multi-pod production deployments.
 *
 * The mode is controlled by ARCHESTRA_DISTRIBUTED_CACHE=true environment variable.
 * When using Helm, this is automatically set to "true" for production deployments.
 */
class CacheManager {
  private memoryCache: Cache | null = null;
  private isDistributed: boolean;
  private defaultTtl: number;

  constructor() {
    this.isDistributed = config.cache.distributed;
    this.defaultTtl = TimeInMs.Hour;

    if (this.isDistributed) {
      logger.info(
        "CacheManager: Using PostgreSQL distributed cache (multi-pod safe)",
      );
    } else {
      logger.info(
        "CacheManager: Using in-memory cache (set ARCHESTRA_DISTRIBUTED_CACHE=true for multi-pod support)",
      );
      this.memoryCache = createCache({
        ttl: this.defaultTtl,
      });
    }
  }

  /**
   * Check if the cache is using distributed storage (PostgreSQL).
   */
  isDistributedCache(): boolean {
    return this.isDistributed;
  }

  /**
   * Get a value from the cache.
   */
  async get<T>(key: AllowedCacheKey): Promise<T | undefined> {
    if (this.isDistributed) {
      return postgresCacheStore.get<T>(key);
    }
    return this.memoryCache!.get<T>(key);
  }

  /**
   * Set a value in the cache with optional TTL.
   */
  async set<T>(
    key: AllowedCacheKey,
    value: T,
    ttl?: number,
  ): Promise<T | undefined> {
    const effectiveTtl = ttl ?? this.defaultTtl;

    if (this.isDistributed) {
      await postgresCacheStore.set(key, value, effectiveTtl);
      return value;
    }
    return this.memoryCache!.set(key, value, effectiveTtl);
  }

  /**
   * Delete a value from the cache.
   */
  async delete(key: AllowedCacheKey): Promise<boolean> {
    if (this.isDistributed) {
      return postgresCacheStore.delete(key);
    }
    return this.memoryCache!.del(key);
  }

  /**
   * Delete all cache entries that start with the given prefix.
   * This is useful for invalidating all related cache entries at once.
   */
  async deleteByPrefix(prefix: AllowedCacheKey): Promise<void> {
    if (this.isDistributed) {
      await postgresCacheStore.deleteByPrefix(prefix);
      return;
    }

    // In-memory: iterate and delete
    const store = this.memoryCache!.stores[0];
    if (store?.iterator) {
      for await (const [key] of store.iterator({})) {
        if (key.startsWith(prefix)) {
          await this.memoryCache!.del(key);
        }
      }
    }
  }

  /**
   * Wrap a function with caching. If the key exists and hasn't expired,
   * return the cached value. Otherwise, call the function and cache the result.
   */
  async wrap<T>(
    key: AllowedCacheKey,
    fnc: () => Promise<T>,
    { ttl, refreshThreshold }: { ttl?: number; refreshThreshold?: number } = {},
  ): Promise<T> {
    if (this.isDistributed) {
      // For distributed cache, implement wrap manually
      const cached = await postgresCacheStore.get<T>(key);
      if (cached !== undefined) {
        return cached;
      }
      const result = await fnc();
      await postgresCacheStore.set(key, result, ttl ?? this.defaultTtl);
      return result;
    }
    return this.memoryCache!.wrap(key, fnc, { ttl, refreshThreshold });
  }
}

export const CacheKey = {
  GetChatModels: "get-chat-models",
  ChatMcpTools: "chat-mcp-tools",
  ProcessedEmail: "processed-email",
  WebhookRateLimit: "webhook-rate-limit",
  OAuthState: "oauth-state",
  McpSession: "mcp-session",
  SsoGroups: "sso-groups",
} as const;
export type CacheKey = (typeof CacheKey)[keyof typeof CacheKey];

type AllowedCacheKey = `${CacheKey}` | `${CacheKey}-${string}`;

export const cacheManager = new CacheManager();

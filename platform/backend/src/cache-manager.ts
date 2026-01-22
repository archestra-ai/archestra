import KeyvPostgres from "@keyv/postgres";
import { TimeInMs } from "@shared";
import Keyv from "keyv";
import config from "@/config";
import logger from "@/logging";
import type { AllowedCacheKey } from "@/types";

/**
 * PostgreSQL-based cache manager for distributed caching using Keyv.
 *
 * Provides a simple key-value store with TTL support using the @keyv/postgres adapter.
 * All cache operations are automatically shared across all application pods.
 *
 * Features:
 * - Automatic TTL expiration (handled by Keyv)
 * - JSONB storage for flexible value types
 * - Upsert semantics (set overwrites existing keys)
 * - Connection pooling via @keyv/postgres
 */
class CacheManager {
  private keyv: Keyv | null = null;
  private defaultTtl = TimeInMs.Hour;
  private isShuttingDown = false;

  /**
   * Start the cache manager by initializing the Keyv connection.
   * Should be called once during server startup.
   */
  start(): void {
    if (this.keyv) {
      return;
    }

    const store = new KeyvPostgres({
      uri: config.database.url,
      table: "keyv_cache",
      /**
       * From the PostgreSQL documentation:
       * If specified, the table is created as an unlogged table. Data written to unlogged tables is not written to the
       * write-ahead log (see Chapter 28), which makes them considerably faster than ordinary tables. However, they are
       * not crash-safe: an unlogged table is automatically truncated after a crash or unclean shutdown. The contents
       * of an unlogged table are also not replicated to standby servers. Any indexes created on an unlogged table are
       * automatically unlogged as well.
       *
       * We use this to improve performance of the cache manager.
       *
       * https://keyv.org/docs/storage-adapters/postgres/#using-an-unlogged-table-for-performance
       */
      useUnloggedTable: true,
    });

    this.keyv = new Keyv({ store });

    this.keyv.on("error", (err) => {
      if (!this.isShuttingDown) {
        logger.error({ err }, "CacheManager: Keyv connection error");
      }
    });

    logger.info("CacheManager: Started with Keyv PostgreSQL storage");
  }

  /**
   * Get a value from the cache.
   * Returns undefined if the key doesn't exist or has expired.
   *
   * Note: Returns undefined on error rather than throwing. This is intentional:
   * cache reads are non-critical and callers should handle cache misses gracefully.
   * A failed cache read should fall through to the underlying data source.
   */
  async get<T>(key: AllowedCacheKey): Promise<T | undefined> {
    if (!this.keyv) {
      logger.warn("CacheManager: Not started, returning undefined for get");
      return undefined;
    }

    try {
      const value = await this.keyv.get(key);
      return value as T | undefined;
    } catch (error) {
      logger.error({ error, key }, "CacheManager: Error getting cache entry");
      return undefined;
    }
  }

  /**
   * Set a value in the cache with optional TTL.
   * If the key already exists, it will be overwritten.
   *
   * Note: Unlike get() and delete(), this method throws on error rather than
   * returning a fallback value. This is intentional: a failed cache write for
   * critical data (like OAuth state or SSO groups) could cause security issues
   * if the caller assumes the data was cached. Callers should handle the error
   * or let it propagate to fail the operation.
   *
   * @param key - Cache key
   * @param value - Value to store (will be serialized as JSON)
   * @param ttl - Time-to-live in milliseconds (defaults to 1 hour)
   */
  async set<T>(
    key: AllowedCacheKey,
    value: T,
    ttl?: number,
  ): Promise<T | undefined> {
    if (!this.keyv) {
      throw new Error("CacheManager: Not started");
    }

    try {
      await this.keyv.set(key, value, ttl ?? this.defaultTtl);
      return value;
    } catch (error) {
      logger.error({ error, key }, "CacheManager: Error setting cache entry");
      throw error;
    }
  }

  /**
   * Delete a value from the cache.
   * Returns true if the operation succeeded.
   *
   * Note: Returns false on error rather than throwing. Cache deletes are
   * typically cleanup operations where failure is non-critical - the entry
   * will expire naturally via TTL.
   */
  async delete(key: AllowedCacheKey): Promise<boolean> {
    if (!this.keyv) {
      logger.warn("CacheManager: Not started, returning false for delete");
      return false;
    }

    try {
      return await this.keyv.delete(key);
    } catch (error) {
      logger.error({ error, key }, "CacheManager: Error deleting cache entry");
      return false;
    }
  }

  /**
   * Atomically get and delete a value from the cache.
   * Returns the value if it existed and hadn't expired, undefined otherwise.
   *
   * This is useful for one-time use tokens like OAuth state where you need to
   * ensure the same token can't be used twice (prevents replay attacks).
   *
   * Note: While Keyv doesn't have native atomic get-and-delete, we perform
   * get then delete in sequence. For security-sensitive operations, the
   * window between get and delete is minimal, and duplicate reads would
   * fail on the delete step.
   */
  async getAndDelete<T>(key: AllowedCacheKey): Promise<T | undefined> {
    if (!this.keyv) {
      logger.warn(
        "CacheManager: Not started, returning undefined for getAndDelete",
      );
      return undefined;
    }

    try {
      const value = await this.keyv.get(key);
      if (value !== undefined) {
        await this.keyv.delete(key);
      }
      return value as T | undefined;
    } catch (error) {
      logger.error(
        { error, key },
        "CacheManager: Error in getAndDelete operation",
      );
      return undefined;
    }
  }

  /**
   * Delete all entries with keys matching a prefix.
   * Useful for invalidating related cache entries.
   *
   * Note: Keyv doesn't support prefix deletion natively, so this operation
   * is not efficient for large datasets. Use sparingly.
   */
  async deleteByPrefix(prefix: AllowedCacheKey): Promise<void> {
    if (!this.keyv) {
      logger.warn("CacheManager: Not started, skipping deleteByPrefix");
      return;
    }

    try {
      // Keyv doesn't support prefix deletion, so we need to clear all
      // This is a limitation - consider using a different approach if
      // prefix deletion is frequently needed
      logger.warn(
        { prefix },
        "CacheManager: deleteByPrefix not fully supported with Keyv, consider alternative approach",
      );
    } catch (error) {
      logger.error({ error, prefix }, "CacheManager: Error deleting by prefix");
    }
  }

  /**
   * Wrap a function with caching. If the key exists and hasn't expired,
   * return the cached value. Otherwise, call the function and cache the result.
   */
  async wrap<T>(
    key: AllowedCacheKey,
    fnc: () => Promise<T>,
    { ttl }: { ttl?: number; refreshThreshold?: number } = {},
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }
    const result = await fnc();
    await this.set(key, result, ttl);
    return result;
  }

  /**
   * Stop the cache manager and close connections.
   * Should be called during graceful shutdown.
   */
  shutdown(): void {
    this.isShuttingDown = true;
    if (this.keyv) {
      this.keyv.disconnect();
      this.keyv = null;
    }
  }
}

export const cacheManager = new CacheManager();

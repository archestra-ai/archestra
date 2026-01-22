import { TimeInMs } from "@shared";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { AllowedCacheKey } from "@/types";

/**
 * PostgreSQL-based cache manager for distributed caching.
 *
 * Provides a simple key-value store with TTL support using the cache table.
 * All cache operations are automatically shared across all application pods.
 *
 * Features:
 * - Automatic TTL expiration (checked on read)
 * - Periodic cleanup of expired entries
 * - JSONB storage for flexible value types
 * - Upsert semantics (set overwrites existing keys)
 */
class CacheManager {
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private defaultTtl = TimeInMs.Hour;
  private isShuttingDown = false;

  constructor() {
    // Don't start cleanup interval in test environment to avoid
    // database access after PGlite connection is closed
    if (process.env.NODE_ENV !== "test") {
      this.startCleanupInterval();
    }
    logger.info("CacheManager: Initialized with PostgreSQL storage");
  }

  /**
   * Get a value from the cache.
   * Returns undefined if the key doesn't exist or has expired.
   */
  async get<T>(key: AllowedCacheKey): Promise<T | undefined> {
    try {
      const result = await db
        .select()
        .from(schema.cacheTable)
        .where(
          and(
            eq(schema.cacheTable.key, key),
            gt(schema.cacheTable.expiresAt, new Date()),
          ),
        )
        .limit(1);

      if (result.length === 0) {
        return undefined;
      }

      return result[0].value as T;
    } catch (error) {
      logger.error({ error, key }, "CacheManager: Error getting cache entry");
      return undefined;
    }
  }

  /**
   * Set a value in the cache with optional TTL.
   * If the key already exists, it will be overwritten.
   *
   * @param key - Cache key
   * @param value - Value to store (will be serialized as JSONB)
   * @param ttl - Time-to-live in milliseconds (defaults to 1 hour)
   */
  async set<T>(
    key: AllowedCacheKey,
    value: T,
    ttl?: number,
  ): Promise<T | undefined> {
    try {
      const expiresAt = new Date(Date.now() + (ttl ?? this.defaultTtl));

      await db
        .insert(schema.cacheTable)
        .values({
          key,
          value: value as unknown as Record<string, unknown>,
          expiresAt,
          createdAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.cacheTable.key,
          set: {
            value: value as unknown as Record<string, unknown>,
            expiresAt,
          },
        });

      return value;
    } catch (error) {
      logger.error({ error, key }, "CacheManager: Error setting cache entry");
      throw error;
    }
  }

  /**
   * Delete a value from the cache.
   * Returns true if the operation succeeded.
   */
  async delete(key: AllowedCacheKey): Promise<boolean> {
    try {
      await db.delete(schema.cacheTable).where(eq(schema.cacheTable.key, key));
      return true;
    } catch (error) {
      logger.error({ error, key }, "CacheManager: Error deleting cache entry");
      return false;
    }
  }

  /**
   * Delete all entries with keys matching a prefix.
   * Useful for invalidating related cache entries.
   */
  async deleteByPrefix(prefix: AllowedCacheKey): Promise<void> {
    try {
      await db
        .delete(schema.cacheTable)
        .where(sql`${schema.cacheTable.key} LIKE ${`${prefix}%`}`);
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
   * Clean up expired cache entries.
   * Called periodically by the cleanup interval.
   */
  private async cleanupExpired(): Promise<number> {
    // Skip cleanup if shutting down
    if (this.isShuttingDown) {
      return 0;
    }

    try {
      const result = await db
        .delete(schema.cacheTable)
        .where(lt(schema.cacheTable.expiresAt, new Date()))
        .returning({ key: schema.cacheTable.key });

      if (result.length > 0) {
        logger.debug(
          { deletedCount: result.length },
          "CacheManager: Cleaned up expired entries",
        );
      }

      return result.length;
    } catch (error) {
      // Silently ignore errors during cleanup - this can happen during
      // shutdown when the database connection is closed
      if (!this.isShuttingDown) {
        logger.error(
          { error },
          "CacheManager: Error cleaning up expired entries",
        );
      }
      return 0;
    }
  }

  /**
   * Start the background cleanup interval.
   */
  private startCleanupInterval(): void {
    if (this.cleanupIntervalId) {
      return;
    }

    this.cleanupIntervalId = setInterval(() => {
      this.cleanupExpired().catch((error) => {
        // Only log if not shutting down
        if (!this.isShuttingDown) {
          logger.error({ error }, "CacheManager: Cleanup interval error");
        }
      });
    }, CacheManager.CLEANUP_INTERVAL_MS);

    // Don't prevent process exit
    this.cleanupIntervalId.unref();
  }

  /**
   * Stop the background cleanup interval and mark as shutting down.
   * Should be called during graceful shutdown.
   */
  shutdown(): void {
    this.isShuttingDown = true;
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }
}

export const cacheManager = new CacheManager();

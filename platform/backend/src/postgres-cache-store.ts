import { and, eq, gt, lt, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";

/**
 * PostgreSQL-based cache store for distributed caching.
 *
 * Provides a simple key-value store with TTL support using PostgreSQL.
 * This enables cache sharing across multiple pods in a Kubernetes deployment.
 *
 * Features:
 * - Automatic TTL expiration (checked on read)
 * - Periodic cleanup of expired entries
 * - JSONB storage for flexible value types
 * - Upsert semantics (set overwrites existing keys)
 */
class PostgresCacheStore {
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.startCleanupInterval();
  }

  /**
   * Get a value from the cache.
   * Returns undefined if the key doesn't exist or has expired.
   */
  async get<T>(key: string): Promise<T | undefined> {
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
      logger.error({ error, key }, "PostgresCacheStore: Error getting cache entry");
      return undefined;
    }
  }

  /**
   * Set a value in the cache with a TTL.
   * If the key already exists, it will be overwritten.
   *
   * @param key - Cache key
   * @param value - Value to store (will be serialized as JSONB)
   * @param ttlMs - Time-to-live in milliseconds
   */
  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    try {
      const expiresAt = new Date(Date.now() + ttlMs);

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
    } catch (error) {
      logger.error({ error, key }, "PostgresCacheStore: Error setting cache entry");
      throw error;
    }
  }

  /**
   * Delete a value from the cache.
   * Returns true if the key was deleted, false if it didn't exist.
   */
  async delete(key: string): Promise<boolean> {
    try {
      const result = await db
        .delete(schema.cacheTable)
        .where(eq(schema.cacheTable.key, key))
        .returning({ key: schema.cacheTable.key });

      return result.length > 0;
    } catch (error) {
      logger.error({ error, key }, "PostgresCacheStore: Error deleting cache entry");
      return false;
    }
  }

  /**
   * Delete all entries with keys matching a prefix.
   * Useful for invalidating related cache entries.
   */
  async deleteByPrefix(prefix: string): Promise<number> {
    try {
      const result = await db
        .delete(schema.cacheTable)
        .where(sql`${schema.cacheTable.key} LIKE ${prefix + "%"}`)
        .returning({ key: schema.cacheTable.key });

      return result.length;
    } catch (error) {
      logger.error({ error, prefix }, "PostgresCacheStore: Error deleting by prefix");
      return 0;
    }
  }

  /**
   * Clean up expired cache entries.
   * Called periodically by the cleanup interval.
   */
  async cleanupExpired(): Promise<number> {
    try {
      const result = await db
        .delete(schema.cacheTable)
        .where(lt(schema.cacheTable.expiresAt, new Date()))
        .returning({ key: schema.cacheTable.key });

      if (result.length > 0) {
        logger.debug(
          { deletedCount: result.length },
          "PostgresCacheStore: Cleaned up expired entries",
        );
      }

      return result.length;
    } catch (error) {
      logger.error({ error }, "PostgresCacheStore: Error cleaning up expired entries");
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
        logger.error({ error }, "PostgresCacheStore: Cleanup interval error");
      });
    }, PostgresCacheStore.CLEANUP_INTERVAL_MS);

    // Don't prevent process exit
    this.cleanupIntervalId.unref();
  }

  /**
   * Stop the background cleanup interval.
   * Call this during graceful shutdown.
   */
  stopCleanupInterval(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }
}

// Singleton instance
export const postgresCacheStore = new PostgresCacheStore();

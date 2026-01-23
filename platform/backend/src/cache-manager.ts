import KeyvPostgres from "@keyv/postgres";
import { TimeInMs } from "@shared";
import { sql } from "drizzle-orm";
import Keyv from "keyv";
import QuickLRU from "quick-lru";
import config from "@/config";
import db from "@/database";
import logger from "@/logging";

/**
 * Predefined cache key prefixes for the distributed cache.
 *
 * These prefixes categorize cache entries and enable efficient invalidation
 * of related entries using deleteByPrefix().
 */
export const CacheKey = {
  /** Chat model list cache */
  GetChatModels: "get-chat-models",
  /** MCP tools for chat feature */
  ChatMcpTools: "chat-mcp-tools",
  /** Deduplication for processed emails */
  ProcessedEmail: "processed-email",
  /** Rate limiting for webhooks */
  WebhookRateLimit: "webhook-rate-limit",
  /** OAuth flow state during authentication */
  OAuthState: "oauth-state",
  /** MCP Gateway session state */
  McpSession: "mcp-session",
  /** SSO groups cache during login flow */
  SsoGroups: "sso-groups",
} as const;

export type CacheKeyPrefix = (typeof CacheKey)[keyof typeof CacheKey];

/**
 * Allowed cache key format: either a base prefix or prefix with suffix.
 *
 * Examples:
 * - "get-chat-models" (just the prefix)
 * - "oauth-state-abc123" (prefix with unique identifier)
 * - "sso-groups-provider:user@example.com" (prefix with composite key)
 */
export type AllowedCacheKey =
  | `${CacheKeyPrefix}`
  | `${CacheKeyPrefix}-${string}`;

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
   * Implementation uses DELETE ... RETURNING for true atomicity - the delete
   * and read happen in a single database operation, preventing race conditions
   * where two requests could both read the same token before either deletes it.
   */
  async getAndDelete<T>(key: AllowedCacheKey): Promise<T | undefined> {
    if (!this.keyv) {
      logger.warn(
        "CacheManager: Not started, returning undefined for getAndDelete",
      );
      return undefined;
    }

    try {
      // Use raw SQL for atomic delete-and-return
      // Keyv stores: key (text), value (jsonb), expires (bigint ms timestamp)
      // The key is namespaced with "keyv:" prefix by Keyv
      const now = Date.now();
      const keyvKey = `keyv:${key}`;
      const result = await db.execute<{ value: string }>(
        sql`DELETE FROM keyv_cache
            WHERE key = ${keyvKey} AND (expires IS NULL OR expires > ${now})
            RETURNING value`,
      );

      if (result.rows.length === 0) {
        return undefined;
      }

      // Keyv stores values as JSON strings in the value column
      const rawValue = result.rows[0].value;
      return (typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue) as
        | T
        | undefined;
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
   * Useful for invalidating related cache entries (e.g., all chat models cache).
   *
   * Uses raw SQL with LIKE pattern matching for efficient bulk deletion.
   * Returns the number of entries deleted.
   */
  async deleteByPrefix(prefix: AllowedCacheKey): Promise<number> {
    if (!this.keyv) {
      logger.warn("CacheManager: Not started, skipping deleteByPrefix");
      return 0;
    }

    try {
      // Keyv namespaces keys with "keyv:" prefix
      // Use LIKE with escaped prefix for pattern matching
      const likePattern = `keyv:${prefix}%`;
      const result = await db.execute<{ count: string }>(
        sql`WITH deleted AS (
          DELETE FROM keyv_cache
          WHERE key LIKE ${likePattern}
          RETURNING 1
        )
        SELECT COUNT(*) as count FROM deleted`,
      );

      const deletedCount = Number.parseInt(result.rows[0]?.count ?? "0", 10);
      if (deletedCount > 0) {
        logger.info(
          { prefix, deletedCount },
          "CacheManager: Deleted entries by prefix",
        );
      }
      return deletedCount;
    } catch (error) {
      logger.error({ error, prefix }, "CacheManager: Error deleting by prefix");
      return 0;
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

/**
 * Configuration options for LRU cache instances.
 */
export interface LRUCacheOptions {
  /** Maximum number of entries in the cache (required) */
  maxSize: number;
  /** Default TTL in milliseconds for cache entries (optional, defaults to 1 hour) */
  defaultTtl?: number;
  /** Callback fired when an entry is evicted from the cache */
  onEviction?: (key: string, value: unknown) => void;
}

/**
 * Entry stored in the LRU cache with TTL support.
 */
interface LRUCacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * In-memory LRU cache manager using QuickLRU.
 *
 * Unlike the distributed CacheManager (PostgreSQL-backed), this cache is
 * local to each pod/process and uses LRU eviction for memory management.
 *
 * Use cases:
 * - Caching objects that can't be serialized (e.g., functions, class instances)
 * - High-frequency access patterns where database round-trips are too slow
 * - Data that doesn't need to be shared across pods (with sticky sessions)
 *
 * Features:
 * - LRU eviction when cache is full
 * - TTL support for automatic expiration
 * - Optional eviction callback for cleanup (e.g., closing connections)
 * - Type-safe get/set operations
 */
export class LRUCacheManager<T = unknown> {
  private lruStore: QuickLRU<string, LRUCacheEntry<T>>;
  private defaultTtl: number;
  private onEviction?: (key: string, value: unknown) => void;

  constructor(options: LRUCacheOptions) {
    this.defaultTtl = options.defaultTtl ?? TimeInMs.Hour;
    this.onEviction = options.onEviction;

    this.lruStore = new QuickLRU<string, LRUCacheEntry<T>>({
      maxSize: options.maxSize,
      onEviction: (key: string, entry: LRUCacheEntry<T>) => {
        if (this.onEviction) {
          this.onEviction(key, entry.value);
        }
      },
    });
  }

  /**
   * Get a value from the cache.
   * Returns undefined if the key doesn't exist or has expired.
   */
  get(key: string): T | undefined {
    const entry = this.lruStore.get(key);
    if (!entry) {
      return undefined;
    }

    // Check if expired
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.lruStore.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Set a value in the cache with optional TTL.
   * If the key already exists, it will be overwritten.
   *
   * @param key - Cache key
   * @param value - Value to store
   * @param ttl - Time-to-live in milliseconds (0 = no expiration)
   */
  set(key: string, value: T, ttl?: number): void {
    const effectiveTtl = ttl ?? this.defaultTtl;
    const entry: LRUCacheEntry<T> = {
      value,
      expiresAt: effectiveTtl > 0 ? Date.now() + effectiveTtl : 0,
    };
    this.lruStore.set(key, entry);
  }

  /**
   * Delete a value from the cache.
   * Returns true if the key existed, false otherwise.
   */
  delete(key: string): boolean {
    return this.lruStore.delete(key);
  }

  /**
   * Check if a key exists in the cache (and is not expired).
   */
  has(key: string): boolean {
    const entry = this.lruStore.get(key);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.lruStore.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Get the current size of the cache.
   */
  get size(): number {
    return this.lruStore.size;
  }

  /**
   * Clear all entries from the cache.
   * Note: This does NOT trigger onEviction callbacks.
   */
  clear(): void {
    this.lruStore.clear();
  }

  /**
   * Delete all entries matching a key prefix.
   */
  deleteByPrefix(prefix: string): void {
    for (const key of this.lruStore.keys()) {
      if (key.startsWith(prefix)) {
        this.lruStore.delete(key);
      }
    }
  }

  /**
   * Get all keys in the cache (for debugging/testing).
   */
  keys(): IterableIterator<string> {
    return this.lruStore.keys();
  }
}

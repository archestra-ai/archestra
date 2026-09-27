import { TimeInMs } from "@archestra/shared/consts";
import QuickLRU from "quick-lru";

/**
 * Configuration options for LRU cache instances.
 */
interface LRUCacheOptions<T = unknown> {
  /** Maximum number of entries in the cache (required) */
  maxSize: number;
  /** Default TTL in milliseconds for cache entries (optional, defaults to 1 hour) */
  defaultTtl?: number;
  /** Callback fired when an entry is evicted from the cache */
  onEviction?: (key: string, value: unknown) => void;
  /**
   * Optional ceiling on total retained bytes, measured with `sizeOf`.
   *
   * An entry count only approximates memory when entries are of similar size.
   * For a cache holding values whose size varies by orders of magnitude it is
   * not a bound at all — a few hundred large entries can exhaust the heap while
   * the cache still looks nearly empty against `maxSize`. Setting this evicts
   * oldest-written entries until the total fits, making `maxSize` a coarse
   * backstop and this the real bound.
   *
   * Eviction order is QuickLRU's approximation, the same one its count-based
   * eviction uses: reads do not reorder entries within a generation, so this is
   * oldest-written-first rather than strictly least-recently-used.
   *
   * Requires `sizeOf`. Enforcement walks the retained entries on write, so
   * callers that set this should keep `maxSize` modest.
   */
  maxBytes?: number;
  /**
   * Approximate retained size of a value, in bytes. Called once per write, and
   * only when `maxBytes` is set.
   */
  sizeOf?: (value: T) => number;
}

/**
 * Entry stored in the LRU cache with TTL support.
 */
interface LRUCacheEntry<T> {
  value: T;
  expiresAt: number;
  /** Size recorded at write time. Always 0 when the cache is not byte-bounded. */
  bytes: number;
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
  private maxBytes?: number;
  private sizeOf?: (value: T) => number;

  constructor(options: LRUCacheOptions<T>) {
    this.defaultTtl = options.defaultTtl ?? TimeInMs.Hour;
    this.onEviction = options.onEviction;
    this.sizeOf = options.sizeOf;
    this.maxBytes = options.sizeOf ? options.maxBytes : undefined;

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
      this.evictExpiredEntry(key, entry);
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
      bytes: this.maxBytes === undefined ? 0 : (this.sizeOf?.(value) ?? 0),
    };
    this.lruStore.set(key, entry);
    this.enforceByteBudget();
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
    // peek, not get: a pure existence check must not promote the entry's
    // recency, or has()-only keys outlive keys that are actually read.
    const entry = this.lruStore.peek(key);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.evictExpiredEntry(key, entry);
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

  /**
   * Total bytes recorded at write time across retained entries. Always 0 when
   * the cache is not byte-bounded.
   */
  get retainedBytes(): number {
    let total = 0;
    for (const [, entry] of this.lruStore.entriesAscending()) {
      total += entry.bytes;
    }
    return total;
  }

  private evictExpiredEntry(key: string, entry: LRUCacheEntry<T>): void {
    if (this.onEviction) {
      this.onEviction(key, entry.value);
    }
    this.lruStore.delete(key);
  }

  /**
   * Evict oldest-written entries until the retained total fits `maxBytes`.
   *
   * Sizes are summed from the retained entries rather than tracked incrementally
   * on purpose: QuickLRU fires `onEviction` for capacity evictions but not for
   * `delete`, so a running counter would drift out of sync with the store and
   * silently under- or over-report. At the modest `maxSize` a byte-bounded cache
   * should use, summing is a handful of integer adds.
   *
   * A value larger than the whole budget is evicted immediately, so callers must
   * not assume a `set` is observable by a later `get` — use the value they wrote.
   */
  private enforceByteBudget(): void {
    const budget = this.maxBytes;
    if (budget === undefined) {
      return;
    }

    const entries = [...this.lruStore.entriesAscending()];
    let total = 0;
    for (const [, entry] of entries) {
      total += entry.bytes;
    }

    for (const [key, entry] of entries) {
      if (total <= budget) {
        break;
      }
      total -= entry.bytes;
      this.lruStore.delete(key);
      if (this.onEviction) {
        this.onEviction(key, entry.value);
      }
    }
  }
}

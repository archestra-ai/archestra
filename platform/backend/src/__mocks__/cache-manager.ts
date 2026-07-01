/**
 * Jest-style mock for `@/cache-manager`, activated per test file by a bare
 * `vi.mock("@/cache-manager");`.
 *
 * `cacheManager` is replaced by a Map-backed fake with real cache semantics
 * (values persist within a test, TTLs ignored) that needs no `start()` — it
 * satisfies both historical mock intents: tests that only needed to silence
 * "CacheManager: Not started" warnings, and tests that assert cached
 * behavior. The store resets before every test, so nothing leaks between
 * tests or files. Tests that need a cache MISS mid-test should
 * `await cacheManager.delete(key)` explicitly.
 *
 * `CacheKey` and `LRUCacheManager` are the real implementations —
 * LRUCacheManager is pure in-memory and safe in tests as-is.
 */
import { beforeEach, vi } from "vitest";

const actual =
  await vi.importActual<typeof import("@/cache-manager")>("@/cache-manager");

export const CacheKey = actual.CacheKey;
export const LRUCacheManager = actual.LRUCacheManager;

class FakeCacheManager {
  private store = new Map<string, unknown>();

  start(): void {}
  shutdown(): void {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T, _ttl?: number): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async getAndDelete<T>(key: string): Promise<T | undefined> {
    const value = this.store.get(key) as T | undefined;
    this.store.delete(key);
    return value;
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  /** Test-only: wipe the store (also done automatically before each test). */
  reset(): void {
    this.store.clear();
  }
}

export const cacheManager = new FakeCacheManager();

// This module is only evaluated inside a test file's context (via vi.mock),
// so registering a hook here is safe and gives every consumer a clean cache
// per test without any per-file boilerplate.
beforeEach(() => {
  cacheManager.reset();
});

/**
 * Start the real distributed cache for one test file, stored in that file's
 * in-process database.
 *
 * Replaces `vi.mock("@/cache-manager")` for files that only needed a started
 * cache, keeping them in the shared-worker project. Entries live in the
 * `keyv_cache` table of the test database, so the per-test reset (truncate or
 * rollback) clears them, and the raw-SQL paths (`getAndDelete`,
 * `appendToList`, `deleteByPrefix`) see the same rows as Keyv's get/set.
 * The cache is shut down after the file so later files in a shared worker
 * keep the default not-started cache.
 */

import { sql } from "drizzle-orm";
import type { KeyvStoreAdapter } from "keyv";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { cacheManager } from "@/cache-manager";
import db from "@/database";

export function setupTestCacheManager(): void {
  beforeAll(() => {
    // An earlier file in a shared worker may have left a cache started.
    cacheManager.shutdown();
    cacheManager.start(createDatabaseStore());
  });
  // Spies on the shared singleton would otherwise outlive this file in a
  // shared worker (the setup's clearAllMocks keeps spy implementations).
  afterEach(() => {
    for (const method of SPYABLE_METHODS) {
      const current = cacheManager[method];
      if (vi.isMockFunction(current)) current.mockRestore();
    }
  });
  afterAll(() => {
    cacheManager.shutdown();
  });
}

// =============================================================================
// Internal helpers
// =============================================================================

const SPYABLE_METHODS = [
  "get",
  "set",
  "delete",
  "getAndDelete",
  "appendToList",
  "getAndDeleteMany",
  "withLock",
  "deleteExpiredByPrefix",
  "deleteByPrefix",
] as const;

/** Keyv store over the same table and key layout as the PostgreSQL adapter. */
function createDatabaseStore(): KeyvStoreAdapter {
  const store: KeyvStoreAdapter = {
    opts: {},
    on: () => store,
    async get(key) {
      const result = await db.execute<{ value: string }>(
        sql`SELECT value FROM keyv_cache WHERE key = ${key}`,
      );
      return result.rows[0]?.value as never;
    },
    async set(key, value) {
      await db.execute(sql`
        INSERT INTO keyv_cache (key, value) VALUES (${key}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `);
    },
    async delete(key) {
      const result = await db.execute(
        sql`DELETE FROM keyv_cache WHERE key = ${key} RETURNING key`,
      );
      return result.rows.length > 0;
    },
    async clear() {
      await db.execute(sql`DELETE FROM keyv_cache`);
    },
  };
  return store;
}

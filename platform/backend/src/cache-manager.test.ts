import { sql } from "drizzle-orm";
import { vi } from "vitest";
import db from "@/database";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

// Use vi.hoisted() to create mock functions that can be accessed in vi.mock
const { mockGet, mockSet, mockDelete, mockDisconnect, mockOn } = vi.hoisted(
  () => ({
    mockGet: vi.fn(),
    mockSet: vi.fn(),
    mockDelete: vi.fn(),
    mockDisconnect: vi.fn(),
    mockOn: vi.fn(),
  }),
);

// Mock Keyv using the hoisted mock functions
vi.mock("keyv", () => ({
  default: class MockKeyv {
    get = mockGet;
    set = mockSet;
    delete = mockDelete;
    disconnect = mockDisconnect;
    on = mockOn;
  },
}));

vi.mock("@keyv/postgres", () => ({
  default: vi.fn(),
}));

// Import after mocks are set up
import { type AllowedCacheKey, cacheManager } from "./cache-manager";

// Alias for convenience in tests
const mockKeyv = {
  get: mockGet,
  set: mockSet,
  delete: mockDelete,
  disconnect: mockDisconnect,
  on: mockOn,
};

/**
 * Helper to ensure keyv_cache table exists for SQL-based tests.
 * This table is normally created by @keyv/postgres but we mock that.
 */
async function ensureKeyvCacheTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS keyv_cache (
      key TEXT PRIMARY KEY,
      value TEXT,
      expires BIGINT
    )
  `);
}

/**
 * Helper to insert a value directly into keyv_cache for testing.
 * Mimics how Keyv stores data with the "keyv:" prefix.
 */
async function insertKeyvEntry(
  key: string,
  value: unknown,
  expiresAt?: number,
) {
  const keyvKey = `keyv:${key}`;
  const jsonValue = JSON.stringify(value);
  await db.execute(
    sql`INSERT INTO keyv_cache (key, value, expires) VALUES (${keyvKey}, ${jsonValue}, ${expiresAt ?? null})
        ON CONFLICT (key) DO UPDATE SET value = ${jsonValue}, expires = ${expiresAt ?? null}`,
  );
}

/**
 * Helper to check if a key exists in keyv_cache.
 */
async function keyvEntryExists(key: string): Promise<boolean> {
  const keyvKey = `keyv:${key}`;
  const result = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*) as count FROM keyv_cache WHERE key = ${keyvKey}`,
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10) > 0;
}

/**
 * Helper to clear all entries from keyv_cache.
 */
async function clearKeyvCache() {
  await db.execute(sql`DELETE FROM keyv_cache`);
}

describe("CacheManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the cacheManager state for each test by calling shutdown
    cacheManager.shutdown();
  });

  afterEach(() => {
    cacheManager.shutdown();
  });

  describe("start", () => {
    test("initializes Keyv connection", () => {
      cacheManager.start();

      // Should register error handler
      expect(mockKeyv.on).toHaveBeenCalledWith("error", expect.any(Function));
    });

    test("does not reinitialize if already started", () => {
      cacheManager.start();
      const firstCallCount = mockKeyv.on.mock.calls.length;

      cacheManager.start();
      // Should not add another error handler
      expect(mockKeyv.on.mock.calls.length).toBe(firstCallCount);
    });
  });

  describe("get", () => {
    test("returns value from cache", async () => {
      cacheManager.start();
      mockKeyv.get.mockResolvedValue({ foo: "bar" });

      const result = await cacheManager.get<{ foo: string }>(
        "test-key" as AllowedCacheKey,
      );

      expect(result).toEqual({ foo: "bar" });
      expect(mockKeyv.get).toHaveBeenCalledWith("test-key");
    });

    test("returns undefined when key does not exist", async () => {
      cacheManager.start();
      mockKeyv.get.mockResolvedValue(undefined);

      const result = await cacheManager.get("missing-key" as AllowedCacheKey);

      expect(result).toBeUndefined();
    });

    test("returns undefined when not started", async () => {
      const result = await cacheManager.get("test-key" as AllowedCacheKey);

      expect(result).toBeUndefined();
      expect(mockKeyv.get).not.toHaveBeenCalled();
    });

    test("returns undefined on error", async () => {
      cacheManager.start();
      mockKeyv.get.mockRejectedValue(new Error("Connection failed"));

      const result = await cacheManager.get("test-key" as AllowedCacheKey);

      expect(result).toBeUndefined();
    });
  });

  describe("set", () => {
    test("sets value with default TTL", async () => {
      cacheManager.start();
      mockKeyv.set.mockResolvedValue(true);

      const value = { foo: "bar" };
      const result = await cacheManager.set(
        "test-key" as AllowedCacheKey,
        value,
      );

      expect(result).toEqual(value);
      expect(mockKeyv.set).toHaveBeenCalledWith(
        "test-key",
        value,
        3600000, // 1 hour default TTL
      );
    });

    test("sets value with custom TTL", async () => {
      cacheManager.start();
      mockKeyv.set.mockResolvedValue(true);

      const value = { foo: "bar" };
      const customTtl = 5000;
      await cacheManager.set("test-key" as AllowedCacheKey, value, customTtl);

      expect(mockKeyv.set).toHaveBeenCalledWith("test-key", value, customTtl);
    });

    test("throws when not started", async () => {
      await expect(
        cacheManager.set("test-key" as AllowedCacheKey, { foo: "bar" }),
      ).rejects.toThrow("CacheManager: Not started");
    });

    test("throws on error", async () => {
      cacheManager.start();
      mockKeyv.set.mockRejectedValue(new Error("Write failed"));

      await expect(
        cacheManager.set("test-key" as AllowedCacheKey, { foo: "bar" }),
      ).rejects.toThrow("Write failed");
    });
  });

  describe("delete", () => {
    test("deletes key from cache", async () => {
      cacheManager.start();
      mockKeyv.delete.mockResolvedValue(true);

      const result = await cacheManager.delete("test-key" as AllowedCacheKey);

      expect(result).toBe(true);
      expect(mockKeyv.delete).toHaveBeenCalledWith("test-key");
    });

    test("returns false when key does not exist", async () => {
      cacheManager.start();
      mockKeyv.delete.mockResolvedValue(false);

      const result = await cacheManager.delete(
        "missing-key" as AllowedCacheKey,
      );

      expect(result).toBe(false);
    });

    test("returns false when not started", async () => {
      const result = await cacheManager.delete("test-key" as AllowedCacheKey);

      expect(result).toBe(false);
      expect(mockKeyv.delete).not.toHaveBeenCalled();
    });

    test("returns false on error", async () => {
      cacheManager.start();
      mockKeyv.delete.mockRejectedValue(new Error("Delete failed"));

      const result = await cacheManager.delete("test-key" as AllowedCacheKey);

      expect(result).toBe(false);
    });
  });

  describe("getAndDelete", () => {
    // These tests use real database calls since getAndDelete uses raw SQL
    // for atomic delete-and-return semantics

    beforeEach(async () => {
      await ensureKeyvCacheTable();
      await clearKeyvCache();
    });

    test("gets and deletes value atomically", async () => {
      cacheManager.start();

      // Insert test data directly into keyv_cache
      await insertKeyvEntry("test-key", { foo: "bar" });

      const result = await cacheManager.getAndDelete<{ foo: string }>(
        "test-key" as AllowedCacheKey,
      );

      expect(result).toEqual({ foo: "bar" });

      // Verify the entry was deleted
      const exists = await keyvEntryExists("test-key");
      expect(exists).toBe(false);
    });

    test("returns undefined if key does not exist", async () => {
      cacheManager.start();

      const result = await cacheManager.getAndDelete(
        "missing-key" as AllowedCacheKey,
      );

      expect(result).toBeUndefined();
    });

    test("returns undefined for expired entries", async () => {
      cacheManager.start();

      // Insert an expired entry (expires in the past)
      await insertKeyvEntry("expired-key", { foo: "bar" }, Date.now() - 1000);

      const result = await cacheManager.getAndDelete(
        "expired-key" as AllowedCacheKey,
      );

      expect(result).toBeUndefined();
    });

    test("returns value for non-expired entries", async () => {
      cacheManager.start();

      // Insert an entry that expires in the future
      await insertKeyvEntry("valid-key", { foo: "bar" }, Date.now() + 60000);

      const result = await cacheManager.getAndDelete<{ foo: string }>(
        "valid-key" as AllowedCacheKey,
      );

      expect(result).toEqual({ foo: "bar" });
    });

    test("returns undefined when not started", async () => {
      const result = await cacheManager.getAndDelete(
        "test-key" as AllowedCacheKey,
      );

      expect(result).toBeUndefined();
    });
  });

  describe("deleteByPrefix", () => {
    // These tests use real database calls since deleteByPrefix uses raw SQL

    beforeEach(async () => {
      await ensureKeyvCacheTable();
      await clearKeyvCache();
    });

    test("deletes all entries matching prefix", async () => {
      cacheManager.start();

      // Insert multiple entries with same prefix
      await insertKeyvEntry("chat-mcp-tools-agent1", { tools: ["a"] });
      await insertKeyvEntry("chat-mcp-tools-agent2", { tools: ["b"] });
      await insertKeyvEntry("chat-mcp-tools-agent3", { tools: ["c"] });
      // Insert entry with different prefix
      await insertKeyvEntry("other-key", { data: "keep" });

      const deletedCount = await cacheManager.deleteByPrefix(
        "chat-mcp-tools" as AllowedCacheKey,
      );

      expect(deletedCount).toBe(3);

      // Verify the matching entries were deleted
      expect(await keyvEntryExists("chat-mcp-tools-agent1")).toBe(false);
      expect(await keyvEntryExists("chat-mcp-tools-agent2")).toBe(false);
      expect(await keyvEntryExists("chat-mcp-tools-agent3")).toBe(false);

      // Verify the non-matching entry still exists
      expect(await keyvEntryExists("other-key")).toBe(true);
    });

    test("returns 0 when no entries match prefix", async () => {
      cacheManager.start();

      await insertKeyvEntry("other-key", { data: "value" });

      const deletedCount = await cacheManager.deleteByPrefix(
        "non-existent-prefix" as AllowedCacheKey,
      );

      expect(deletedCount).toBe(0);
    });

    test("returns 0 when not started", async () => {
      const deletedCount = await cacheManager.deleteByPrefix(
        "test-prefix" as AllowedCacheKey,
      );

      expect(deletedCount).toBe(0);
    });
  });

  describe("wrap", () => {
    test("returns cached value if it exists", async () => {
      cacheManager.start();
      mockKeyv.get.mockResolvedValue("cached-result");

      const fnc = vi.fn().mockResolvedValue("fresh-result");
      const result = await cacheManager.wrap(
        "test-key" as AllowedCacheKey,
        fnc,
      );

      expect(result).toBe("cached-result");
      expect(fnc).not.toHaveBeenCalled();
      expect(mockKeyv.set).not.toHaveBeenCalled();
    });

    test("calls function and caches result on cache miss", async () => {
      cacheManager.start();
      mockKeyv.get.mockResolvedValue(undefined);
      mockKeyv.set.mockResolvedValue(true);

      const fnc = vi.fn().mockResolvedValue("fresh-result");
      const result = await cacheManager.wrap(
        "test-key" as AllowedCacheKey,
        fnc,
      );

      expect(result).toBe("fresh-result");
      expect(fnc).toHaveBeenCalled();
      expect(mockKeyv.set).toHaveBeenCalledWith(
        "test-key",
        "fresh-result",
        3600000,
      );
    });

    test("respects custom TTL", async () => {
      cacheManager.start();
      mockKeyv.get.mockResolvedValue(undefined);
      mockKeyv.set.mockResolvedValue(true);

      const fnc = vi.fn().mockResolvedValue("result");
      const customTtl = 10000;
      await cacheManager.wrap("test-key" as AllowedCacheKey, fnc, {
        ttl: customTtl,
      });

      expect(mockKeyv.set).toHaveBeenCalledWith(
        "test-key",
        "result",
        customTtl,
      );
    });
  });

  describe("shutdown", () => {
    test("disconnects Keyv and clears state", () => {
      cacheManager.start();
      cacheManager.shutdown();

      expect(mockKeyv.disconnect).toHaveBeenCalled();
    });

    test("handles shutdown when not started", () => {
      // Should not throw
      expect(() => cacheManager.shutdown()).not.toThrow();
    });
  });
});

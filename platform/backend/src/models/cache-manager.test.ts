import { vi } from "vitest";
import { afterEach, describe, expect, it } from "@/test";
import { CacheKey } from "@/types";
import { cacheManager } from "./cache-manager";

describe("CacheManager", () => {
  afterEach(async () => {
    // Clean up cache between tests
    await cacheManager.delete(CacheKey.GetChatModels);
    await cacheManager.delete(`${CacheKey.GetChatModels}-test-suffix`);
    await cacheManager.delete(`${CacheKey.GetChatModels}-openai`);
    await cacheManager.delete(`${CacheKey.GetChatModels}-anthropic`);
  });

  describe("get and set", () => {
    it("should return undefined for non-existent key", async () => {
      const result = await cacheManager.get<string>(CacheKey.GetChatModels);
      expect(result).toBeUndefined();
    });

    it("should store and retrieve a value", async () => {
      const testData = { name: "test", value: 123 };
      await cacheManager.set(CacheKey.GetChatModels, testData);

      const result = await cacheManager.get<typeof testData>(
        CacheKey.GetChatModels,
      );
      expect(result).toEqual(testData);
    });

    it("should store and retrieve with suffixed key", async () => {
      const testData = ["model1", "model2"];
      await cacheManager.set(`${CacheKey.GetChatModels}-test-suffix`, testData);

      const result = await cacheManager.get<string[]>(
        `${CacheKey.GetChatModels}-test-suffix`,
      );
      expect(result).toEqual(["model1", "model2"]);
    });

    it("should expire values after TTL", async () => {
      const testData = "short-lived";
      const shortTtl = 100; // 100ms

      await cacheManager.set(CacheKey.GetChatModels, testData, shortTtl);

      // Should exist immediately
      let result = await cacheManager.get<string>(CacheKey.GetChatModels);
      expect(result).toBe(testData);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, shortTtl + 50));

      // Should be expired
      result = await cacheManager.get<string>(CacheKey.GetChatModels);
      expect(result).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("should delete an existing key", async () => {
      await cacheManager.set(CacheKey.GetChatModels, "to-delete");

      const deleted = await cacheManager.delete(CacheKey.GetChatModels);
      expect(deleted).toBe(true);

      const result = await cacheManager.get<string>(CacheKey.GetChatModels);
      expect(result).toBeUndefined();
    });

    it("should return true when deleting non-existent key", async () => {
      const deleted = await cacheManager.delete(CacheKey.GetChatModels);
      expect(deleted).toBe(true);
    });
  });

  describe("wrap", () => {
    it("should call function and cache result on first call", async () => {
      const mockFn = vi.fn().mockResolvedValue("computed-value");

      const result = await cacheManager.wrap(CacheKey.GetChatModels, mockFn);

      expect(result).toBe("computed-value");
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("should return cached value on subsequent calls", async () => {
      const mockFn = vi
        .fn()
        .mockResolvedValueOnce("first-value")
        .mockResolvedValueOnce("second-value");

      const result1 = await cacheManager.wrap(CacheKey.GetChatModels, mockFn);
      const result2 = await cacheManager.wrap(CacheKey.GetChatModels, mockFn);

      expect(result1).toBe("first-value");
      expect(result2).toBe("first-value"); // Still returns cached value
      expect(mockFn).toHaveBeenCalledTimes(1); // Only called once
    });

    it("should handle complex objects", async () => {
      const complexData = {
        models: [
          { id: "1", name: "gpt-4", provider: "openai" },
          { id: "2", name: "claude-3", provider: "anthropic" },
        ],
        metadata: { count: 2, lastUpdated: new Date().toISOString() },
      };
      const mockFn = vi.fn().mockResolvedValue(complexData);

      const result = await cacheManager.wrap(CacheKey.GetChatModels, mockFn);

      expect(result).toEqual(complexData);
    });

    it("should handle arrays", async () => {
      const arrayData = ["model1", "model2", "model3"];
      const mockFn = vi.fn().mockResolvedValue(arrayData);

      const result = await cacheManager.wrap(CacheKey.GetChatModels, mockFn);

      expect(result).toEqual(arrayData);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("suffixed keys", () => {
    it("should support dynamic key suffixes", async () => {
      const provider1Data = ["gpt-4", "gpt-3.5"];
      const provider2Data = ["claude-3", "claude-2"];

      await cacheManager.set(`${CacheKey.GetChatModels}-openai`, provider1Data);
      await cacheManager.set(
        `${CacheKey.GetChatModels}-anthropic`,
        provider2Data,
      );

      const result1 = await cacheManager.get<string[]>(
        `${CacheKey.GetChatModels}-openai`,
      );
      const result2 = await cacheManager.get<string[]>(
        `${CacheKey.GetChatModels}-anthropic`,
      );

      expect(result1).toEqual(provider1Data);
      expect(result2).toEqual(provider2Data);
    });
  });

  describe("getAndDelete", () => {
    it("should atomically get and delete a value", async () => {
      const testData = { token: "oauth-state-123", userId: "user-1" };
      await cacheManager.set(CacheKey.OAuthState, testData);

      // First call should return the value
      const result = await cacheManager.getAndDelete<typeof testData>(
        CacheKey.OAuthState,
      );
      expect(result).toEqual(testData);

      // Second call should return undefined (value was deleted)
      const result2 = await cacheManager.getAndDelete<typeof testData>(
        CacheKey.OAuthState,
      );
      expect(result2).toBeUndefined();
    });

    it("should return undefined for non-existent key", async () => {
      const result = await cacheManager.getAndDelete<string>(
        CacheKey.OAuthState,
      );
      expect(result).toBeUndefined();
    });

    it("should not return expired values", async () => {
      const testData = "expired-value";
      const shortTtl = 50; // 50ms

      await cacheManager.set(CacheKey.OAuthState, testData, shortTtl);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, shortTtl + 50));

      // Should return undefined for expired value
      const result = await cacheManager.getAndDelete<string>(
        CacheKey.OAuthState,
      );
      expect(result).toBeUndefined();
    });

    it("should prevent race conditions - only one caller gets the value", async () => {
      const testData = { state: "unique-oauth-state" };
      await cacheManager.set(`${CacheKey.OAuthState}-race`, testData);

      // Simulate concurrent access - both calls happen simultaneously
      const results = await Promise.all([
        cacheManager.getAndDelete<typeof testData>(
          `${CacheKey.OAuthState}-race`,
        ),
        cacheManager.getAndDelete<typeof testData>(
          `${CacheKey.OAuthState}-race`,
        ),
      ]);

      // Only one should get the value, the other should get undefined
      const nonNullResults = results.filter((r) => r !== undefined);
      expect(nonNullResults).toHaveLength(1);
      expect(nonNullResults[0]).toEqual(testData);
    });
  });

  describe("error handling and edge cases", () => {
    it("should handle empty object values", async () => {
      await cacheManager.set(CacheKey.GetChatModels, {});
      const result = await cacheManager.get<Record<string, unknown>>(
        CacheKey.GetChatModels,
      );
      expect(result).toEqual({});
    });

    it("should handle empty array values", async () => {
      await cacheManager.set(CacheKey.GetChatModels, []);
      const result = await cacheManager.get<unknown[]>(CacheKey.GetChatModels);
      expect(result).toEqual([]);
    });

    it("should handle deeply nested objects", async () => {
      const deeplyNested = {
        level1: {
          level2: {
            level3: {
              level4: {
                value: "deep",
              },
            },
          },
        },
      };
      await cacheManager.set(CacheKey.GetChatModels, deeplyNested);
      const result = await cacheManager.get<typeof deeplyNested>(
        CacheKey.GetChatModels,
      );
      expect(result).toEqual(deeplyNested);
    });

    it("should handle special characters in string values", async () => {
      const specialChars = "test\"with'special\nchars\t\\and/slashes";
      await cacheManager.set(CacheKey.GetChatModels, specialChars);
      const result = await cacheManager.get<string>(CacheKey.GetChatModels);
      expect(result).toBe(specialChars);
    });

    it("should handle unicode characters", async () => {
      const unicode = "测试 тест 🎉 emoji";
      await cacheManager.set(CacheKey.GetChatModels, unicode);
      const result = await cacheManager.get<string>(CacheKey.GetChatModels);
      expect(result).toBe(unicode);
    });
  });

  describe("concurrent access patterns", () => {
    it("should handle multiple concurrent writes to same key", async () => {
      const writes = Array.from({ length: 10 }, (_, i) =>
        cacheManager.set(CacheKey.GetChatModels, { version: i }),
      );

      await Promise.all(writes);

      // One of the values should have won
      const result = await cacheManager.get<{ version: number }>(
        CacheKey.GetChatModels,
      );
      expect(result).toBeDefined();
      expect(typeof result?.version).toBe("number");
    });

    it("should handle concurrent read and write", async () => {
      await cacheManager.set(CacheKey.GetChatModels, { initial: true });

      // Run reads and writes concurrently
      const operations = [
        cacheManager.get<{ initial?: boolean; updated?: boolean }>(
          CacheKey.GetChatModels,
        ),
        cacheManager.set(CacheKey.GetChatModels, { updated: true }),
        cacheManager.get<{ initial?: boolean; updated?: boolean }>(
          CacheKey.GetChatModels,
        ),
      ];

      const results = await Promise.all(operations);

      // All operations should complete without error
      expect(results).toHaveLength(3);
    });

    it("should handle many concurrent operations", async () => {
      const key = `${CacheKey.GetChatModels}-concurrent`;

      // Set initial value
      await cacheManager.set(key, 0);

      // Run many concurrent operations
      const operations = Array.from({ length: 50 }, (_, i) =>
        i % 2 === 0 ? cacheManager.get<number>(key) : cacheManager.set(key, i),
      );

      // All operations should complete without throwing
      await expect(Promise.all(operations)).resolves.toBeDefined();

      // Cleanup
      await cacheManager.delete(key);
    });
  });
});

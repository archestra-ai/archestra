import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheKey, cacheManager } from "./cache-manager";

describe("CacheManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    // Clean up cache between tests
    await cacheManager.delete(CacheKey.GetChatModels);
    await cacheManager.delete(`${CacheKey.GetChatModels}-test-suffix`);
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

    it("should respect custom TTL", async () => {
      const testData = "short-lived";
      const shortTtl = 1000; // 1 second

      await cacheManager.set(CacheKey.GetChatModels, testData, shortTtl);

      // Should exist immediately
      let result = await cacheManager.get<string>(CacheKey.GetChatModels);
      expect(result).toBe(testData);

      // Advance time past TTL
      vi.advanceTimersByTime(shortTtl + 100);

      // Should be expired
      result = await cacheManager.get<string>(CacheKey.GetChatModels);
      expect(result).toBeUndefined();
    });

    it("should use default TTL (1 hour) when not specified", async () => {
      const testData = "default-ttl";
      await cacheManager.set(CacheKey.GetChatModels, testData);

      // Should exist after 59 minutes
      vi.advanceTimersByTime(59 * 60 * 1000);
      let result = await cacheManager.get<string>(CacheKey.GetChatModels);
      expect(result).toBe(testData);

      // Should be expired after 1 hour + a bit
      vi.advanceTimersByTime(2 * 60 * 1000);
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

    it("should return true when deleting non-existent key (cache-manager behavior)", async () => {
      // Note: cache-manager library returns true even for non-existent keys
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

    it("should respect custom TTL in wrap", async () => {
      const mockFn = vi
        .fn()
        .mockResolvedValueOnce("first-value")
        .mockResolvedValueOnce("second-value");
      const shortTtl = 1000;

      const result1 = await cacheManager.wrap(CacheKey.GetChatModels, mockFn, {
        ttl: shortTtl,
      });
      expect(result1).toBe("first-value");
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Advance time past TTL
      vi.advanceTimersByTime(shortTtl + 100);

      // Should call function again after TTL expires
      const result2 = await cacheManager.wrap(CacheKey.GetChatModels, mockFn, {
        ttl: shortTtl,
      });
      expect(result2).toBe("second-value");
      expect(mockFn).toHaveBeenCalledTimes(2);
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

      // Clean up
      await cacheManager.delete(`${CacheKey.GetChatModels}-openai`);
      await cacheManager.delete(`${CacheKey.GetChatModels}-anthropic`);
    });
  });
});

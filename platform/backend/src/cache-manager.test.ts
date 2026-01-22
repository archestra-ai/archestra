import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock functions that will be used to track calls
const mockGet = vi.fn();
const mockSet = vi.fn();
const mockDelete = vi.fn();
const mockDisconnect = vi.fn();
const mockOn = vi.fn();

// Mock Keyv - define the class inside the factory to avoid hoisting issues
vi.mock("keyv", () => {
  return {
    default: class MockKeyv {
      get = mockGet;
      set = mockSet;
      delete = mockDelete;
      disconnect = mockDisconnect;
      on = mockOn;
    },
  };
});

vi.mock("@keyv/postgres", () => ({
  default: vi.fn(),
}));

import type { AllowedCacheKey } from "@/types";
// Import after mocks are set up
import { cacheManager } from "./cache-manager";

// Alias for convenience in tests
const mockKeyv = {
  get: mockGet,
  set: mockSet,
  delete: mockDelete,
  disconnect: mockDisconnect,
  on: mockOn,
};

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
    test("gets and deletes value atomically", async () => {
      cacheManager.start();
      mockKeyv.get.mockResolvedValue({ foo: "bar" });
      mockKeyv.delete.mockResolvedValue(true);

      const result = await cacheManager.getAndDelete<{ foo: string }>(
        "test-key" as AllowedCacheKey,
      );

      expect(result).toEqual({ foo: "bar" });
      expect(mockKeyv.get).toHaveBeenCalledWith("test-key");
      expect(mockKeyv.delete).toHaveBeenCalledWith("test-key");
    });

    test("does not call delete if key does not exist", async () => {
      cacheManager.start();
      mockKeyv.get.mockResolvedValue(undefined);

      const result = await cacheManager.getAndDelete(
        "missing-key" as AllowedCacheKey,
      );

      expect(result).toBeUndefined();
      expect(mockKeyv.get).toHaveBeenCalled();
      expect(mockKeyv.delete).not.toHaveBeenCalled();
    });

    test("returns undefined when not started", async () => {
      const result = await cacheManager.getAndDelete(
        "test-key" as AllowedCacheKey,
      );

      expect(result).toBeUndefined();
      expect(mockKeyv.get).not.toHaveBeenCalled();
    });

    test("returns undefined on error", async () => {
      cacheManager.start();
      mockKeyv.get.mockRejectedValue(new Error("Connection failed"));

      const result = await cacheManager.getAndDelete(
        "test-key" as AllowedCacheKey,
      );

      expect(result).toBeUndefined();
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

import { vi } from "vitest";
import { type AllowedCacheKey, CacheKey } from "@/cache-manager";
import { beforeEach, describe, expect, test } from "@/test";
import { isRateLimited, type RateLimitEntry } from "./utils";

// Mock cacheManager while preserving other exports (like LRUCacheManager, CacheKey)
const mockCache = new Map<string, RateLimitEntry>();
vi.mock("@/cache-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cache-manager")>();
  return {
    ...actual,
    cacheManager: {
      get: vi.fn(async (key: string) => mockCache.get(key)),
      set: vi.fn(async (key: string, value: RateLimitEntry) => {
        mockCache.set(key, value);
      }),
    },
  };
});

describe("isRateLimited", () => {
  const testConfig = { windowMs: 60_000, maxRequests: 3 };
  const testCacheKey =
    `${CacheKey.WebhookRateLimit}-test-127.0.0.1` as AllowedCacheKey;

  beforeEach(() => {
    mockCache.clear();
    vi.clearAllMocks();
  });

  test("allows first request and initializes counter", async () => {
    const result = await isRateLimited(testCacheKey, testConfig);

    expect(result).toBe(false);
    expect(mockCache.get(testCacheKey)).toMatchObject({
      count: 1,
    });
  });

  test("allows requests under the limit", async () => {
    // First request
    expect(await isRateLimited(testCacheKey, testConfig)).toBe(false);
    // Second request
    expect(await isRateLimited(testCacheKey, testConfig)).toBe(false);
    // Third request (at limit)
    expect(await isRateLimited(testCacheKey, testConfig)).toBe(false);

    expect(mockCache.get(testCacheKey)?.count).toBe(3);
  });

  test("blocks requests at the limit", async () => {
    // Make requests up to the limit
    for (let i = 0; i < testConfig.maxRequests; i++) {
      await isRateLimited(testCacheKey, testConfig);
    }

    // Next request should be blocked
    const result = await isRateLimited(testCacheKey, testConfig);
    expect(result).toBe(true);
  });

  test("resets counter after window expires", async () => {
    // Set up an expired entry
    const expiredEntry: RateLimitEntry = {
      count: testConfig.maxRequests,
      windowStart: Date.now() - testConfig.windowMs - 1000, // 1 second past expiry
    };
    mockCache.set(testCacheKey, expiredEntry);

    // Should allow the request and reset counter
    const result = await isRateLimited(testCacheKey, testConfig);

    expect(result).toBe(false);
    expect(mockCache.get(testCacheKey)).toMatchObject({
      count: 1,
    });
  });

  test("uses different counters for different cache keys", async () => {
    const cacheKey1 =
      `${CacheKey.WebhookRateLimit}-test-192.168.1.1` as AllowedCacheKey;
    const cacheKey2 =
      `${CacheKey.WebhookRateLimit}-test-192.168.1.2` as AllowedCacheKey;

    // Max out first IP
    for (let i = 0; i < testConfig.maxRequests; i++) {
      await isRateLimited(cacheKey1, testConfig);
    }

    // First IP should be blocked
    expect(await isRateLimited(cacheKey1, testConfig)).toBe(true);

    // Second IP should still be allowed
    expect(await isRateLimited(cacheKey2, testConfig)).toBe(false);
  });

  test("respects different rate limit configurations", async () => {
    const strictConfig = { windowMs: 60_000, maxRequests: 1 };
    const lenientConfig = { windowMs: 60_000, maxRequests: 100 };

    const strictKey =
      `${CacheKey.WebhookRateLimit}-strict-127.0.0.1` as AllowedCacheKey;
    const lenientKey =
      `${CacheKey.WebhookRateLimit}-lenient-127.0.0.1` as AllowedCacheKey;

    // First request on strict - allowed
    expect(await isRateLimited(strictKey, strictConfig)).toBe(false);
    // Second request on strict - blocked
    expect(await isRateLimited(strictKey, strictConfig)).toBe(true);

    // Multiple requests on lenient - all allowed
    for (let i = 0; i < 10; i++) {
      expect(await isRateLimited(lenientKey, lenientConfig)).toBe(false);
    }
  });

  test("preserves windowStart when incrementing count", async () => {
    // First request sets windowStart
    await isRateLimited(testCacheKey, testConfig);
    const initialEntry = mockCache.get(testCacheKey);
    const initialWindowStart = initialEntry?.windowStart;

    // Second request should preserve windowStart
    await isRateLimited(testCacheKey, testConfig);
    const updatedEntry = mockCache.get(testCacheKey);

    expect(updatedEntry?.windowStart).toBe(initialWindowStart);
    expect(updatedEntry?.count).toBe(2);
  });
});

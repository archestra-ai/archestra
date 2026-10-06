import QuickLRU from "quick-lru";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LRUCacheManager } from "./in-memory-lru-cache";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("LRUCacheManager.setMany", () => {
  test("enforces bytes once for a large batch and measures each write once", () => {
    const sizeOf = vi.fn((value: string) => value.length);
    const cache = new LRUCacheManager<string>({
      maxSize: 4096,
      maxBytes: 8192,
      sizeOf,
    });
    const scan = vi.spyOn(QuickLRU.prototype, "entriesAscending");
    const entries = Array.from(
      { length: 2048 },
      (_, index) => [`k${index}`, "1234"] as const,
    );
    cache.setMany(entries);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(sizeOf).toHaveBeenCalledTimes(entries.length);
    expect(cache.size).toBe(2048);
    expect(cache.retainedBytes).toBe(8192);
    expect(cache.get("k0")).toBe("1234");
    expect(cache.get("k2047")).toBe("1234");

    scan.mockClear();
    cache.setMany([]);
    expect(scan).not.toHaveBeenCalled();
    cache.set("extra", "1234");
    expect(scan).toHaveBeenCalledTimes(1);
    expect(cache.has("k0")).toBe(false);
    expect(cache.get("extra")).toBe("1234");
    expect(cache.retainedBytes).toBe(8192);
  });

  test("evicts individual oldest values and rejects an oversized value", () => {
    const onEviction = vi.fn();
    const cache = new LRUCacheManager<string>({
      maxSize: 10,
      maxBytes: 4,
      sizeOf: (value) => value.length,
      onEviction,
    });
    cache.setMany([
      ["a", "aa"],
      ["b", "bb"],
      ["c", "cc"],
    ]);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("bb");
    expect(cache.get("c")).toBe("cc");
    expect(cache.retainedBytes).toBe(4);
    expect(onEviction.mock.calls).toEqual([["a", "aa"]]);

    cache.setMany([["huge", "12345"]]);
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.retainedBytes).toBe(0);
    expect(onEviction.mock.calls).toEqual([
      ["a", "aa"],
      ["b", "bb"],
      ["c", "cc"],
      ["huge", "12345"],
    ]);
  });

  test("accounts for duplicate and overwritten keys without phantom bytes", () => {
    const onEviction = vi.fn();
    const cache = new LRUCacheManager<string>({
      maxSize: 10,
      maxBytes: 5,
      sizeOf: (value) => value.length,
      onEviction,
    });
    cache.setMany([
      ["a", "a"],
      ["a", "aaaa"],
      ["b", "b"],
    ]);
    expect(cache.get("a")).toBe("aaaa");
    expect(cache.retainedBytes).toBe(5);
    expect(onEviction).not.toHaveBeenCalled();
    cache.setMany([["b", "bbb"]]);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("bbb");
    expect(cache.retainedBytes).toBe(3);
    expect(onEviction.mock.calls).toEqual([["a", "aaaa"]]);
    expect(cache.delete("b")).toBe(true);
    expect(cache.retainedBytes).toBe(0);
    cache.setMany([
      ["scope:a", "aa"],
      ["scope:b", "bb"],
    ]);
    cache.deleteByPrefix("scope:");
    expect(cache.retainedBytes).toBe(0);
    expect(onEviction.mock.calls).toEqual([["a", "aaaa"]]);
  });

  test("preserves count-based eviction and callbacks without a byte budget", () => {
    const batchedEviction = vi.fn();
    const singleEviction = vi.fn();
    const sizeOf = vi.fn(() => 100);
    const batched = new LRUCacheManager<string>({
      maxSize: 2,
      defaultTtl: 0,
      sizeOf,
      onEviction: batchedEviction,
    });
    const single = new LRUCacheManager<string>({
      maxSize: 2,
      defaultTtl: 0,
      onEviction: singleEviction,
    });
    const entries = ["a", "b", "c", "d", "e"].map(
      (key) => [key, key.toUpperCase()] as const,
    );
    batched.setMany(entries);
    for (const [key, value] of entries) single.set(key, value);
    expect(batched.size).toBeLessThanOrEqual(2);
    expect([...batched.keys()]).toEqual([...single.keys()]);
    for (const [key] of entries) expect(batched.get(key)).toBe(single.get(key));
    expect(batchedEviction.mock.calls).toEqual(singleEviction.mock.calls);
    expect(batched.retainedBytes).toBe(0);
    expect(sizeOf).not.toHaveBeenCalled();
  });

  test("does not extend a batch when an eviction callback appends to its input", () => {
    const entries: [string, string][] = [
      ["a", "A"],
      ["b", "B"],
      ["c", "C"],
      ["d", "D"],
    ];
    const onEviction = vi.fn(() => {
      if (entries.length === 4) entries.push(["late", "L"]);
    });
    const cache = new LRUCacheManager<string>({
      maxSize: 1,
      defaultTtl: 0,
      onEviction,
    });
    cache.setMany(entries);
    expect(entries).toHaveLength(5);
    expect(cache.size).toBe(1);
    expect(cache.get("d")).toBe("D");
    expect(cache.get("late")).toBeUndefined();
    expect(onEviction).toHaveBeenCalledTimes(3);
  });

  test("does not refresh old TTLs when another batch is written", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    const onEviction = vi.fn();
    const cache = new LRUCacheManager<string>({
      maxSize: 10,
      defaultTtl: 100,
      maxBytes: 10,
      sizeOf: (value) => value.length,
      onEviction,
    });
    cache.setMany([
      ["a", "A"],
      ["b", "B"],
    ]);
    vi.setSystemTime(1050);
    cache.setMany([["c", "C"]]);
    expect(cache.retainedBytes).toBe(3);
    vi.setSystemTime(1100);
    expect(cache.get("a")).toBe("A");
    vi.setSystemTime(1101);
    expect(cache.has("a")).toBe(false);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("C");
    expect(cache.retainedBytes).toBe(1);
    expect(onEviction.mock.calls).toEqual([
      ["a", "A"],
      ["b", "B"],
    ]);
    vi.setSystemTime(1151);
    expect(cache.get("c")).toBeUndefined();
    expect(cache.retainedBytes).toBe(0);
    expect(onEviction.mock.calls).toEqual([
      ["a", "A"],
      ["b", "B"],
      ["c", "C"],
    ]);
  });

  test("supports custom TTL and non-expiring batches without changing clear/delete callbacks", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    const onEviction = vi.fn();
    const cache = new LRUCacheManager<string>({
      maxSize: 10,
      defaultTtl: 100,
      onEviction,
    });
    cache.setMany([["short", "S"]], 20);
    cache.setMany([["permanent", "P"]], 0);
    cache.set("single", "legacy", 0);
    vi.setSystemTime(1021);
    expect(cache.get("short")).toBeUndefined();
    expect(cache.has("short")).toBe(false);
    vi.setSystemTime(1_000_000);
    expect(cache.get("permanent")).toBe("P");
    expect(cache.get("single")).toBe("legacy");
    expect(cache.delete("permanent")).toBe(true);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(onEviction.mock.calls).toEqual([["short", "S"]]);
  });

  test("enforces the budget for a partial batch when measurement fails", () => {
    const onEviction = vi.fn();
    const cache = new LRUCacheManager<string>({
      maxSize: 10,
      maxBytes: 5,
      sizeOf: (value) => {
        if (value === "bad") throw new Error("measurement failed");
        return value.length;
      },
      onEviction,
    });
    const scan = vi.spyOn(QuickLRU.prototype, "entriesAscending");
    expect(() =>
      cache.setMany([
        ["a", "aaaa"],
        ["b", "bbbb"],
        ["bad", "bad"],
      ]),
    ).toThrow("measurement failed");
    expect(scan).toHaveBeenCalledTimes(1);
    expect(cache.retainedBytes).toBe(4);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("bbbb");
    expect(cache.get("bad")).toBeUndefined();
    expect(onEviction.mock.calls).toEqual([["a", "aaaa"]]);
  });
});

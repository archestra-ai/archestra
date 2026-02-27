import { vi } from "vitest";
import { afterEach, describe, expect, test } from "@/test";

import { isTransientDbError, withDbRetry, wrapPoolWithRetry } from "./retry";

// Suppress logger output during tests
vi.mock("@/logging", () => ({
  default: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe("isTransientDbError", () => {
  test("returns false for non-Error values", () => {
    expect(isTransientDbError("string")).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
    expect(isTransientDbError(42)).toBe(false);
  });

  test("returns false for generic errors", () => {
    expect(isTransientDbError(new Error("Something went wrong"))).toBe(false);
    expect(isTransientDbError(new Error("Invalid query syntax"))).toBe(false);
  });

  test("detects ECONNREFUSED", () => {
    expect(
      isTransientDbError(new Error("connect ECONNREFUSED 10.2.124.50:5432")),
    ).toBe(true);
  });

  test("detects ECONNRESET", () => {
    expect(isTransientDbError(new Error("read ECONNRESET"))).toBe(true);
  });

  test("detects EPIPE", () => {
    expect(isTransientDbError(new Error("write EPIPE"))).toBe(true);
  });

  test("detects ETIMEDOUT", () => {
    expect(isTransientDbError(new Error("connect ETIMEDOUT"))).toBe(true);
  });

  test("detects 'Connection terminated'", () => {
    expect(isTransientDbError(new Error("Connection terminated"))).toBe(true);
  });

  test("detects 'Connection terminated unexpectedly'", () => {
    expect(
      isTransientDbError(new Error("Connection terminated unexpectedly")),
    ).toBe(true);
  });

  test("detects 'Connection terminated due to connection timeout'", () => {
    expect(
      isTransientDbError(
        new Error("Connection terminated due to connection timeout"),
      ),
    ).toBe(true);
  });

  test("detects 'timeout expired'", () => {
    expect(isTransientDbError(new Error("timeout expired"))).toBe(true);
  });

  test("detects PostgreSQL SQLSTATE connection error codes", () => {
    const codes = [
      "08000",
      "08001",
      "08003",
      "08004",
      "08006",
      "57P01",
      "57P02",
      "57P03",
    ];
    for (const code of codes) {
      const error = Object.assign(new Error("db error"), { code });
      expect(isTransientDbError(error)).toBe(true);
    }
  });

  test("returns false for non-transient PostgreSQL error codes", () => {
    const error = Object.assign(new Error("duplicate key"), { code: "23505" });
    expect(isTransientDbError(error)).toBe(false);
  });

  test("detects transient error wrapped as cause (DrizzleQueryError pattern)", () => {
    const pgError = new Error("connect ECONNREFUSED 10.2.124.50:5432");
    const drizzleError = new Error("Failed query: SELECT 1", {
      cause: pgError,
    });
    expect(isTransientDbError(drizzleError)).toBe(true);
  });

  test("returns false when cause is not transient", () => {
    const pgError = new Error("duplicate key value violates unique constraint");
    const drizzleError = new Error("Failed query: INSERT INTO ...", {
      cause: pgError,
    });
    expect(isTransientDbError(drizzleError)).toBe(false);
  });

  test("detects transient error in deeply nested cause chain", () => {
    const innerError = new Error("Connection terminated unexpectedly");
    const middleError = new Error("query failed", { cause: innerError });
    const outerError = new Error("Failed query: SELECT *", {
      cause: middleError,
    });
    expect(isTransientDbError(outerError)).toBe(true);
  });

  test("returns false when cause chain exceeds max depth", () => {
    // Build a chain deeper than MAX_CAUSE_DEPTH (5)
    let error: Error = new Error("ECONNREFUSED");
    for (let i = 0; i < 7; i++) {
      error = new Error(`wrapper ${i}`, { cause: error });
    }
    expect(isTransientDbError(error)).toBe(false);
  });
});

describe("withDbRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns result on first successful attempt", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await withDbRetry(fn);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries on transient error and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.2.124.50:5432"))
      .mockResolvedValue("recovered");

    const result = await withDbRetry(fn, { maxRetries: 3 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("does not retry on non-transient error", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        new Error("duplicate key value violates unique constraint"),
      );

    await expect(withDbRetry(fn)).rejects.toThrow("duplicate key");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("throws after exhausting all retries", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new Error("connect ECONNREFUSED 10.2.124.50:5432"));

    await expect(withDbRetry(fn, { maxRetries: 2 })).rejects.toThrow(
      "ECONNREFUSED",
    );
    // 1 initial + 2 retries = 3
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("respects custom maxRetries", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new Error("Connection terminated unexpectedly"));

    await expect(withDbRetry(fn, { maxRetries: 1 })).rejects.toThrow(
      "Connection terminated",
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("retries multiple times before succeeding", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
      .mockRejectedValueOnce(
        new Error("Connection terminated due to connection timeout"),
      )
      .mockResolvedValue("finally");

    const result = await withDbRetry(fn, { maxRetries: 3 });
    expect(result).toBe("finally");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("retries DrizzleQueryError with transient cause", async () => {
    const pgError = new Error("connect ECONNREFUSED 10.2.124.50:5432");
    const drizzleError = new Error(
      "Failed query: select * from users where id = $1",
      { cause: pgError },
    );

    const fn = vi
      .fn()
      .mockRejectedValueOnce(drizzleError)
      .mockResolvedValue([{ id: 1 }]);

    const result = await withDbRetry(fn);
    expect(result).toEqual([{ id: 1 }]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("applies backoff delay between retries", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue("ok");

    const promise = withDbRetry(fn, { maxRetries: 1 });

    // First attempt fails immediately, then backoff timer starts
    // Advance past the max possible delay (BASE_DELAY * 2^0 * 1.25 = 125ms)
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

describe("wrapPoolWithRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("retries pool.query() on transient error", async () => {
    const mockQuery = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.2.124.50:5432"))
      .mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });

    const pool = { query: mockQuery };
    wrapPoolWithRetry(pool);

    const result = await pool.query("SELECT 1");
    expect(result).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  test("does not retry on non-transient error", async () => {
    const mockQuery = vi.fn().mockRejectedValue(new Error("syntax error"));

    const pool = { query: mockQuery };
    wrapPoolWithRetry(pool);

    await expect(pool.query("INVALID SQL")).rejects.toThrow("syntax error");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("passes through callback-style calls without retry", async () => {
    const mockQuery = vi.fn();
    const callback = vi.fn();

    const pool = { query: mockQuery };
    wrapPoolWithRetry(pool);

    pool.query("SELECT 1", callback);
    expect(mockQuery).toHaveBeenCalledWith("SELECT 1", callback);
  });

  test("preserves query arguments across retries", async () => {
    const mockQuery = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection terminated"))
      .mockResolvedValue({ rows: [] });

    const pool = { query: mockQuery };
    wrapPoolWithRetry(pool);

    await pool.query("SELECT * FROM users WHERE id = $1", [42]);

    // Both calls should have the same arguments
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      "SELECT * FROM users WHERE id = $1",
      [42],
    );
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      "SELECT * FROM users WHERE id = $1",
      [42],
    );
  });

  test("returns result on first success without retry", async () => {
    const mockQuery = vi
      .fn()
      .mockResolvedValue({ rows: [{ count: 5 }], rowCount: 1 });

    const pool = { query: mockQuery };
    wrapPoolWithRetry(pool);

    const result = await pool.query("SELECT count(*) FROM users");
    expect(result).toEqual({ rows: [{ count: 5 }], rowCount: 1 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("calling wrapPoolWithRetry twice does not double-wrap", async () => {
    const mockQuery = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.2.124.50:5432"))
      .mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });

    const pool = { query: mockQuery };
    wrapPoolWithRetry(pool);
    wrapPoolWithRetry(pool); // second call should be a no-op

    const result = await pool.query("SELECT 1");
    expect(result).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
    // Should be 2 (1 initial + 1 retry), NOT 4+ from double-wrapped retries
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

import { vi } from "vitest";
import { afterEach, describe, expect, test } from "@/test";

import {
  getTransientDbErrorCode,
  installDbErrorSafetyNet,
  isTransientDbError,
  withDbRetry,
  withTransactionRetry,
  wrapPoolWithRetry,
} from "./retry";

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

  test("detects EAI_AGAIN (temporary DNS resolution failure)", () => {
    expect(
      isTransientDbError(
        new Error("getaddrinfo EAI_AGAIN db.example.internal"),
      ),
    ).toBe(true);
  });

  test("detects ENOTFOUND (DNS name did not resolve)", () => {
    expect(
      isTransientDbError(
        new Error("getaddrinfo ENOTFOUND db.example.internal"),
      ),
    ).toBe(true);
  });

  test("detects ENOTFOUND wrapped as a DrizzleQueryError cause", () => {
    const pgError = Object.assign(
      new Error("getaddrinfo ENOTFOUND postgresql.archestra-dev"),
      { code: "ENOTFOUND" },
    );
    const drizzleError = new Error(
      'Failed query: select "id" from "agents" where "slug" = $1',
      { cause: pgError },
    );
    expect(isTransientDbError(drizzleError)).toBe(true);
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

  test("detects 'timeout exceeded when trying to connect'", () => {
    expect(
      isTransientDbError(new Error("timeout exceeded when trying to connect")),
    ).toBe(true);
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

describe("getTransientDbErrorCode", () => {
  test("returns a stable code for socket-level errors", () => {
    expect(
      getTransientDbErrorCode(new Error("connect ECONNREFUSED 10.0.0.1:5432")),
    ).toBe("ECONNREFUSED");
    expect(
      getTransientDbErrorCode(new Error("getaddrinfo EAI_AGAIN db.internal")),
    ).toBe("EAI_AGAIN");
    expect(
      getTransientDbErrorCode(new Error("getaddrinfo ENOTFOUND db.internal")),
    ).toBe("ENOTFOUND");
  });

  test("maps message patterns to low-cardinality codes", () => {
    expect(
      getTransientDbErrorCode(
        new Error("timeout exceeded when trying to connect"),
      ),
    ).toBe("pool_connect_timeout");
    expect(
      getTransientDbErrorCode(new Error("Connection terminated unexpectedly")),
    ).toBe("connection_terminated");
  });

  test("returns the SQLSTATE code for transient PostgreSQL errors", () => {
    const error = Object.assign(new Error("db error"), { code: "57P01" });
    expect(getTransientDbErrorCode(error)).toBe("57P01");
  });

  test("unwraps the cause chain (DrizzleQueryError pattern)", () => {
    const drizzleError = new Error("Failed query: select 1", {
      cause: new Error("getaddrinfo EAI_AGAIN db.internal"),
    });
    expect(getTransientDbErrorCode(drizzleError)).toBe("EAI_AGAIN");
  });

  test("returns null for non-transient errors", () => {
    expect(getTransientDbErrorCode(new Error("duplicate key"))).toBeNull();
    expect(getTransientDbErrorCode("not an error")).toBeNull();
    expect(getTransientDbErrorCode(null)).toBeNull();
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

  test("stops retrying when the time budget is exhausted", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValue(new Error("connect ECONNREFUSED 10.2.124.50:5432"));

    // Budget allows the first backoff (~100-125ms) but not the second
    // (~200-250ms on top of ~100-125ms elapsed).
    const promise = withDbRetry(fn, { maxRetries: 5, budgetMs: 250 });
    const assertion = expect(promise).rejects.toThrow("ECONNREFUSED");

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    // 1 initial + 1 retry, then the budget cuts it off despite maxRetries: 5
    expect(fn).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
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

describe("withTransactionRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("retries the whole transaction operation on transient errors", async () => {
    const runTransaction = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
      .mockResolvedValue("committed");

    const result = await withTransactionRetry(runTransaction);

    expect(result).toBe("committed");
    expect(runTransaction).toHaveBeenCalledTimes(2);
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

describe("installDbErrorSafetyNet", () => {
  // installDbErrorSafetyNet is idempotent (module-scoped flag), so capture
  // the handlers once via a process.on spy on the first install, then drive
  // them directly. Tests are independent because each invokes a captured
  // handler reference, not a live process event.
  const processOnSpy = vi.spyOn(process, "on");
  installDbErrorSafetyNet();
  const uncaughtHandler = processOnSpy.mock.calls.find(
    ([event]) => event === "uncaughtException",
  )?.[1] as (err: unknown) => void;
  const rejectionHandler = processOnSpy.mock.calls.find(
    ([event]) => event === "unhandledRejection",
  )?.[1] as (reason: unknown) => void;
  processOnSpy.mockRestore();

  let processExitSpy: ReturnType<typeof vi.spyOn>;

  function armExit(): void {
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit called with ${code}`);
    }) as never);
  }

  afterEach(() => {
    processExitSpy?.mockRestore();
  });

  test("registers handlers for uncaughtException and unhandledRejection", () => {
    expect(uncaughtHandler).toBeDefined();
    expect(rejectionHandler).toBeDefined();
  });

  test("swallows transient pg errors on uncaughtException without exiting", () => {
    armExit();
    uncaughtHandler(new Error("Connection terminated unexpectedly"));
    uncaughtHandler(new Error("read ECONNRESET"));
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  test("exits on non-transient uncaughtException", () => {
    armExit();
    expect(() => uncaughtHandler(new Error("Something unrelated"))).toThrow(
      /process\.exit called with 1/,
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  test("swallows transient pg rejections on unhandledRejection without exiting", () => {
    armExit();
    rejectionHandler(new Error("Connection terminated"));
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  test("exits on non-transient unhandledRejection", () => {
    armExit();
    expect(() => rejectionHandler(new Error("not a connection error"))).toThrow(
      /process\.exit called with 1/,
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  test("is idempotent — second call does not register new handlers", () => {
    const spy = vi.spyOn(process, "on");
    installDbErrorSafetyNet();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

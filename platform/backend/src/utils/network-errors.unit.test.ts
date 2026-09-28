import { describe, expect, test } from "vitest";
import {
  collectErrorCodes,
  isConnectionErrno,
  isFetchConnectivityError,
  isTimeoutErrno,
} from "./network-errors";

describe("isConnectionErrno", () => {
  test("returns true for connection-failure codes", () => {
    expect(isConnectionErrno("ECONNREFUSED")).toBe(true);
    expect(isConnectionErrno("ECONNRESET")).toBe(true);
    expect(isConnectionErrno("ENOTFOUND")).toBe(true);
    expect(isConnectionErrno("EAI_AGAIN")).toBe(true);
    expect(isConnectionErrno("UND_ERR_SOCKET")).toBe(true);
  });

  test("returns false for timeout codes and unknowns", () => {
    expect(isConnectionErrno("ETIMEDOUT")).toBe(false);
    expect(isConnectionErrno("EPERM")).toBe(false);
  });

  test("returns false for a missing code", () => {
    expect(isConnectionErrno(undefined)).toBe(false);
    expect(isConnectionErrno(null)).toBe(false);
  });
});

describe("isTimeoutErrno", () => {
  test("returns true for timeout codes", () => {
    expect(isTimeoutErrno("ETIMEDOUT")).toBe(true);
    expect(isTimeoutErrno("ESOCKETTIMEDOUT")).toBe(true);
    expect(isTimeoutErrno("UND_ERR_HEADERS_TIMEOUT")).toBe(true);
  });

  test("returns false for connection-failure codes and unknowns", () => {
    expect(isTimeoutErrno("ECONNRESET")).toBe(false);
    expect(isTimeoutErrno("nope")).toBe(false);
  });

  test("returns false for a missing code", () => {
    expect(isTimeoutErrno(undefined)).toBe(false);
    expect(isTimeoutErrno(null)).toBe(false);
  });
});

describe("collectErrorCodes", () => {
  test("returns the code of a single error", () => {
    const err = Object.assign(new Error("boom"), { code: "ECONNRESET" });
    expect(collectErrorCodes(err)).toEqual(["ECONNRESET"]);
  });

  test("walks the cause chain (fetch wraps the real errno as cause)", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
      }),
    });
    expect(collectErrorCodes(err)).toEqual(["ECONNRESET"]);
  });

  test("collects codes at multiple levels of the cause chain", () => {
    const err = Object.assign(new Error("outer"), {
      code: "OUTER",
      cause: Object.assign(new Error("inner"), { code: "ETIMEDOUT" }),
    });
    expect(collectErrorCodes(err)).toEqual(["OUTER", "ETIMEDOUT"]);
  });

  test("stops at maxDepth, guarding against circular causes", () => {
    const a = new Error("a") as Error & { code?: string; cause?: unknown };
    const b = new Error("b") as Error & { code?: string; cause?: unknown };
    a.code = "A";
    b.code = "B";
    a.cause = b;
    b.cause = a; // circular
    // Default maxDepth is 3 levels: a, b, a — three codes, no infinite loop.
    expect(collectErrorCodes(a)).toEqual(["A", "B", "A"]);
  });

  test("returns an empty array for a non-error or code-less error", () => {
    expect(collectErrorCodes("not an error")).toEqual([]);
    expect(collectErrorCodes(new Error("no code"))).toEqual([]);
  });

  test("collects per-address codes from nested connection failures", () => {
    const error = new TypeError("fetch failed", {
      cause: new AggregateError([
        Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
        Object.assign(new Error("unreachable"), { code: "ENETUNREACH" }),
      ]),
    });
    expect(collectErrorCodes(error)).toEqual(["ETIMEDOUT", "ENETUNREACH"]);
    expect(collectErrorCodes(error, 2)).toEqual([]);
  });

  test("bounds circular aggregate traversal", () => {
    const aggregate = new AggregateError([]);
    aggregate.errors.push(aggregate);
    expect(collectErrorCodes(aggregate)).toEqual([]);
  });
});

describe("isFetchConnectivityError", () => {
  test.each([
    "ECONNREFUSED",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
  ])("recognizes a native fetch failure caused by %s", (code) => {
    const cause = Object.assign(new Error("network failure"), { code });
    expect(
      isFetchConnectivityError(new TypeError("fetch failed", { cause })),
    ).toBe(true);
    expect(isFetchConnectivityError(cause)).toBe(false);
    expect(isFetchConnectivityError(new Error("Failed query", { cause }))).toBe(
      false,
    );
  });

  test("does not hide invalid URLs or unexplained fetch failures", () => {
    const cause = Object.assign(new TypeError("Invalid URL"), {
      code: "ERR_INVALID_URL",
    });
    expect(
      isFetchConnectivityError(new TypeError("fetch failed", { cause })),
    ).toBe(false);
    expect(isFetchConnectivityError(new TypeError("fetch failed"))).toBe(false);
  });
});

import { describe, expect, test } from "vitest";
import {
  collectErrorCodes,
  isConnectionErrno,
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
});

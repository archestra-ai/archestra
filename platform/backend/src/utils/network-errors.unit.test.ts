import net from "node:net";
import { describe, expect, test } from "vitest";
import {
  collectErrorCodes,
  getConnectionFailureTarget,
  getNetworkErrorCode,
  isConnectionErrno,
  isFetchConnectivityError,
  isTimeoutErrno,
  outboundRequestTargets,
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

describe("getConnectionFailureTarget", () => {
  test.each([
    [
      "Connect Timeout Error (attempted address: api.example.com:443, timeout: 10000ms)",
      { host: "api.example.com", port: 443 },
    ],
    [
      "Connect Timeout Error (attempted addresses: 2001:db8::1:443, 203.0.113.10:443, timeout: 10000ms)",
      { host: "2001:db8::1", port: 443 },
    ],
  ])("reads the endpoint from undici's connect timeout: %s", (message, target) => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error(message), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    expect(getConnectionFailureTarget(error)).toEqual(target);
  });

  test("reads the origin of a failed outbound request that names no endpoint", async () => {
    outboundRequestTargets.install();
    const peer = net.createServer((socket) => {
      socket.on("data", () => socket.resetAndDestroy());
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const { port } = peer.address() as net.AddressInfo;
    try {
      const error = await fetch(`http://127.0.0.1:${port}/`).catch(
        (failure: unknown) => failure,
      );
      // The reset itself carries no address, port, or host name.
      expect((error as Error).cause).not.toHaveProperty("address");
      expect(getConnectionFailureTarget(error)).toEqual({
        host: "127.0.0.1",
        port,
      });
      expect(getNetworkErrorCode(error)).toBe("ECONNRESET");
    } finally {
      await new Promise((resolve) => peer.close(resolve));
    }
  });

  test("reads the dialed address and port from a connect failure", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
      address: "203.0.113.10",
      port: 443,
    });
    expect(getConnectionFailureTarget(error)).toEqual({
      host: "203.0.113.10",
      port: 443,
    });
  });

  test("reads the looked-up hostname from a DNS failure", () => {
    const error = Object.assign(new Error("lookup failed"), {
      code: "ENOTFOUND",
      syscall: "getaddrinfo",
      hostname: "api.example.com",
    });
    expect(getConnectionFailureTarget(error)).toEqual({
      host: "api.example.com",
      port: null,
    });
  });

  test("finds the target behind wrappers and aggregate members", () => {
    const error = new Error("Connection error.", {
      cause: new TypeError("fetch failed", {
        cause: new AggregateError([
          Object.assign(new Error("connect ETIMEDOUT 2001:db8::1:443"), {
            code: "ETIMEDOUT",
            syscall: "connect",
            address: "2001:db8::1",
            port: 443,
          }),
        ]),
      }),
    });
    expect(getConnectionFailureTarget(error)).toEqual({
      host: "2001:db8::1",
      port: 443,
    });
  });

  test.each([
    [
      "MCP error -32603: request to https://api.example.com/v1 failed, reason: getaddrinfo ENOTFOUND api.example.com",
      { host: "api.example.com", port: null },
    ],
    [
      "upstream failed (connect ECONNREFUSED 203.0.113.10:443)",
      { host: "203.0.113.10", port: 443 },
    ],
    ["connect EPERM [2001:db8::1]:5432", { host: "2001:db8::1", port: 5432 }],
    ["connect ETIMEDOUT ::1:5432", { host: "::1", port: 5432 }],
  ])("parses the target Node renders into %s", (message, target) => {
    expect(getConnectionFailureTarget(new Error(message))).toEqual(target);
  });

  test("returns null when the failure names no target", () => {
    expect(
      getConnectionFailureTarget(
        new Error("Connection terminated unexpectedly"),
      ),
    ).toBeNull();
    expect(
      getConnectionFailureTarget(
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      ),
    ).toBeNull();
    expect(getConnectionFailureTarget("not an error")).toBeNull();
  });
});

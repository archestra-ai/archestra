// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveMcpToolCallStatus } from "./tool-call-status";

describe("resolveMcpToolCallStatus", () => {
  it("resolves the structured cancelled marker, even when isError is set", () => {
    // Cancelled wins over isError: a user-initiated stop must never be
    // painted as a failure.
    expect(
      resolveMcpToolCallStatus({
        isError: true,
        _meta: { archestraError: { type: "cancelled", message: "stopped" } },
      }),
    ).toBe("cancelled");
    expect(
      resolveMcpToolCallStatus({
        isError: false,
        _meta: { archestraError: { type: "cancelled", message: "stopped" } },
      }),
    ).toBe("cancelled");
  });

  it("resolves errors and successes as before", () => {
    expect(resolveMcpToolCallStatus({ isError: true })).toBe("error");
    expect(resolveMcpToolCallStatus({ isError: false, content: [] })).toBe(
      "success",
    );
    // Other structured error types are still errors, not cancellations.
    expect(
      resolveMcpToolCallStatus({
        isError: true,
        _meta: { archestraError: { type: "generic", message: "boom" } },
      }),
    ).toBe("error");
  });

  it("reads the outcome a metadata-only row kept in place of its result", () => {
    const notStored = { __redacted: "log_content_policy" } as const;

    expect(resolveMcpToolCallStatus({ ...notStored, isError: false })).toBe(
      "success",
    );
    expect(resolveMcpToolCallStatus({ ...notStored, isError: true })).toBe(
      "error",
    );
    expect(
      resolveMcpToolCallStatus({
        ...notStored,
        isError: true,
        errorType: "cancelled",
      }),
    ).toBe("cancelled");
  });

  it("treats malformed shapes as success rather than crashing", () => {
    expect(resolveMcpToolCallStatus(null)).toBe("success");
    expect(resolveMcpToolCallStatus("text")).toBe("success");
    expect(resolveMcpToolCallStatus({ _meta: "nope" })).toBe("success");
    expect(resolveMcpToolCallStatus({ _meta: { archestraError: null } })).toBe(
      "success",
    );
  });
});

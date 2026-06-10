import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAllAppDiagnostics,
  clearAppDiagnostics,
  drainAppDiagnostics,
  getAppDiagnosticCounts,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_DIAGNOSTICS_PER_APP,
  parseForwardedDiagnostic,
  reportAppDiagnostic,
} from "./app-diagnostics-store";

const APP = "947051c7-ea8e-48ed-8077-a3cc904d9d61";

describe("parseForwardedDiagnostic", () => {
  it("accepts a valid runtime error and truncates the message", () => {
    const entry = parseForwardedDiagnostic({
      type: "mcp-apps:runtime-error",
      errorType: "error",
      message: "x".repeat(2000),
    });
    expect(entry?.type).toBe("error");
    expect(entry?.message).toHaveLength(MAX_DIAGNOSTIC_MESSAGE_LENGTH);
  });

  it("maps a CSP violation to a readable message", () => {
    const entry = parseForwardedDiagnostic({
      type: "mcp-apps:csp-violation",
      directive: "connect-src",
      blockedUri: "https://evil.example.com",
    });
    expect(entry).toEqual({
      type: "csp-violation",
      message: "CSP violation: connect-src blocked https://evil.example.com",
    });
  });

  it.each([
    ["null", null],
    ["string", "boom"],
    ["unknown type", { type: "mcp-apps:something-else", message: "x" }],
    [
      "forged errorType",
      { type: "mcp-apps:runtime-error", errorType: "evil", message: "x" },
    ],
    [
      "csp-violation smuggled as runtime-error",
      {
        type: "mcp-apps:runtime-error",
        errorType: "csp-violation",
        message: "x",
      },
    ],
    [
      "non-string message",
      { type: "mcp-apps:runtime-error", errorType: "error", message: 42 },
    ],
    [
      "empty message",
      { type: "mcp-apps:runtime-error", errorType: "error", message: "" },
    ],
  ])("rejects %s", (_label, payload) => {
    expect(parseForwardedDiagnostic(payload)).toBeNull();
  });
});

describe("diagnostics store", () => {
  beforeEach(() => {
    clearAllAppDiagnostics();
  });

  it("caps entries per app", () => {
    for (let i = 0; i < MAX_DIAGNOSTICS_PER_APP + 10; i++) {
      reportAppDiagnostic(APP, 1, { type: "error", message: `error ${i}` });
    }
    expect(getAppDiagnosticCounts().get(APP)).toBe(MAX_DIAGNOSTICS_PER_APP);
  });

  it("dedupes by type and message prefix", () => {
    reportAppDiagnostic(APP, 1, { type: "error", message: "same thing" });
    reportAppDiagnostic(APP, 1, { type: "error", message: "same thing" });
    reportAppDiagnostic(APP, 1, {
      type: "console.error",
      message: "same thing",
    });
    expect(getAppDiagnosticCounts().get(APP)).toBe(2);
  });

  it("resets the collection when the version changes", () => {
    reportAppDiagnostic(APP, 1, { type: "error", message: "v1 error" });
    reportAppDiagnostic(APP, 2, { type: "error", message: "v2 error" });
    const drained = drainAppDiagnostics();
    expect(drained).toEqual([
      {
        appId: APP,
        version: 2,
        entries: [{ type: "error", message: "v2 error" }],
      },
    ]);
  });

  it("drain is attach-once: a second drain returns nothing", () => {
    reportAppDiagnostic(APP, 1, { type: "error", message: "boom" });
    expect(drainAppDiagnostics()).toHaveLength(1);
    expect(drainAppDiagnostics()).toHaveLength(0);
    expect(getAppDiagnosticCounts().get(APP)).toBeUndefined();
  });

  it("clearAppDiagnostics drops one app's entries (unmount/re-render)", () => {
    reportAppDiagnostic(APP, 1, { type: "error", message: "boom" });
    clearAppDiagnostics(APP);
    expect(drainAppDiagnostics()).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAllAppDiagnostics,
  drainAppDiagnostics,
  getAppDiagnosticCounts,
  getAppDiagnostics,
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

  it.each([
    "console.log",
    "console.warn",
    "console.info",
  ] as const)("accepts %s forwarded over the runtime-error lane", (errorType) => {
    const entry = parseForwardedDiagnostic({
      type: "mcp-apps:runtime-error",
      errorType,
      message: "hello from the app",
    });
    expect(entry).toEqual({ type: errorType, message: "hello from the app" });
  });

  it("accepts a render-check diagnostic over the runtime-error lane", () => {
    const entry = parseForwardedDiagnostic({
      type: "mcp-apps:runtime-error",
      errorType: "render-check",
      message: "[hidden-overridden] #modal is still rendered",
    });
    expect(entry).toEqual({
      type: "render-check",
      message: "[hidden-overridden] #modal is still rendered",
    });
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
    expect(getAppDiagnosticCounts().get(APP)).toEqual({
      errors: MAX_DIAGNOSTICS_PER_APP,
      logs: 0,
    });
  });

  it("dedupes by type and message prefix", () => {
    reportAppDiagnostic(APP, 1, { type: "error", message: "same thing" });
    reportAppDiagnostic(APP, 1, { type: "error", message: "same thing" });
    reportAppDiagnostic(APP, 1, {
      type: "console.error",
      message: "same thing",
    });
    expect(getAppDiagnosticCounts().get(APP)).toEqual({ errors: 2, logs: 0 });
  });

  it("splits counts into error-class diagnostics vs ordinary logs", () => {
    reportAppDiagnostic(APP, 1, { type: "error", message: "boom" });
    reportAppDiagnostic(APP, 1, { type: "console.error", message: "bad" });
    reportAppDiagnostic(APP, 1, { type: "console.log", message: "hi" });
    reportAppDiagnostic(APP, 1, { type: "console.warn", message: "careful" });
    reportAppDiagnostic(APP, 1, { type: "console.info", message: "fyi" });
    expect(getAppDiagnosticCounts().get(APP)).toEqual({ errors: 2, logs: 3 });
  });

  it("counts a render-check diagnostic as an error, not a log", () => {
    reportAppDiagnostic(APP, 1, {
      type: "render-check",
      message: "[hidden-overridden] stuck modal: #confirm-modal",
    });
    expect(getAppDiagnosticCounts().get(APP)).toEqual({ errors: 1, logs: 0 });
  });

  it("a newer version resets the collection; a stale mount is ignored", () => {
    reportAppDiagnostic(APP, 1, { type: "error", message: "v1 error" });
    reportAppDiagnostic(APP, 2, { type: "error", message: "v2 error" });
    // the old scaffold_app card (still mounted, labeled v1) reports late
    reportAppDiagnostic(APP, 1, { type: "error", message: "stale v1 report" });
    // an unknown-version mount ranks below any known version
    reportAppDiagnostic(APP, null, { type: "error", message: "unknown" });
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

  it("rejects a late stale-version report that arrives after the version was drained", () => {
    reportAppDiagnostic(APP, 2, { type: "error", message: "v2 error" });
    expect(drainAppDiagnostics()).toHaveLength(1);

    // An older still-mounted card reports after the drain cleared the map.
    const accepted = reportAppDiagnostic(APP, 1, {
      type: "error",
      message: "stale late v1",
    });
    expect(accepted).toBe(false);
    expect(getAppDiagnostics(APP)).toBeNull();
    expect(drainAppDiagnostics()).toHaveLength(0);
  });

  it("clearAllAppDiagnostics resets the drained high-water so a version can report again", () => {
    reportAppDiagnostic(APP, 2, { type: "error", message: "v2 error" });
    drainAppDiagnostics();
    clearAllAppDiagnostics();

    const accepted = reportAppDiagnostic(APP, 1, {
      type: "error",
      message: "v1 after reset",
    });
    expect(accepted).toBe(true);
  });

  it("getAppDiagnostics returns the current snapshot (for the render POST)", () => {
    expect(getAppDiagnostics(APP)).toBeNull();
    reportAppDiagnostic(APP, 3, { type: "error", message: "boom" });
    expect(getAppDiagnostics(APP)).toEqual({
      appId: APP,
      version: 3,
      entries: [{ type: "error", message: "boom" }],
    });
  });
});

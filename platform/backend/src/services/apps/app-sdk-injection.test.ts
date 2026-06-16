import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARCHESTRA_TOOL_PREFIX,
  TOOL_APP_DATA_DELETE_SHORT_NAME,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
  TOOL_APP_LLM_COMPLETE_SHORT_NAME,
} from "@archestra/shared";
import { describe, expect, test } from "vitest";

// The injectAppSdk envelope logic moved to the app_runtime_core Rust crate; its
// behavior (anchor selection, escaping, injection order) is covered by that
// crate's table tests and the app-runtime-rs smoke test. What remains here is
// the drift guard on the static Apps SDK file the backend serves.

describe("the Apps SDK static file", () => {
  const sdk = readFileSync(
    join(__dirname, "../../static/archestra-app-sdk.js"),
    "utf-8",
  );

  test("dispatches the canonical reserved tool names (drift guard)", () => {
    for (const shortName of [
      TOOL_APP_DATA_GET_SHORT_NAME,
      TOOL_APP_DATA_SET_SHORT_NAME,
      TOOL_APP_DATA_LIST_SHORT_NAME,
      TOOL_APP_DATA_DELETE_SHORT_NAME,
      TOOL_APP_LLM_COMPLETE_SHORT_NAME,
    ]) {
      expect(sdk).toContain(`"${ARCHESTRA_TOOL_PREFIX}${shortName}"`);
    }
  });

  test("exposes the documented window.archestra namespace", () => {
    for (const member of [
      "window.archestra",
      "ready",
      "user:",
      "storage:",
      "llm:",
      "tools:",
      "ui:",
      "context:",
      "openLink",
      "requestDisplayMode",
      "complete:",
      "prompt:",
    ]) {
      expect(sdk).toContain(member);
    }
  });

  test("installs runtime-error diagnostics hooks and stays eval-free", () => {
    expect(sdk).toContain("mcp-apps:runtime-error");
    for (const hook of [
      '"error"',
      '"unhandledrejection"',
      'hookConsole("error", "console.error"',
      'hookConsole("warn", "console.warn"',
      'hookConsole("log", "console.log"',
    ]) {
      expect(sdk).toContain(hook);
    }
    // the sandbox CSP forbids code generation, and the violation listener only
    // mutes the ext-apps bundle's probe — our SDK must never trigger one
    expect(sdk).not.toMatch(/\beval\s*\(/);
    expect(sdk).not.toContain("new Function");
  });

  test("reads the injected globals and surfaces typed auth errors", () => {
    expect(sdk).toContain("__ARCHESTRA_APP_SDK_URL__");
    expect(sdk).toContain("__ARCHESTRA_APP_CONTEXT__");
    expect(sdk).toContain("auth_required");
    expect(sdk).toContain("auth_expired");
  });
});

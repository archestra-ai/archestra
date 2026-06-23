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
import { buildPlatformCspContent } from "./app-sdk-injection";
import { APP_PLATFORM_CSP } from "./app-ui-policy";

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

  // The SDK also reads the bundle URL from the bootstrap context, so a foreign
  // host that never runs the sandbox proxy can still load it.
  test("prefers the context-provided guest SDK URL", () => {
    expect(sdk).toContain("context.sdkUrl");
  });
});

// The sandbox proxy injects a securitypolicyviolation listener into every guest
// to surface runtime CSP problems. The ext-apps bundle probes code-gen support
// with a caught `new Function("")`, which still fires a (benign) violation, so
// the listener mutes it. Owned apps carry their SDK URL in the backend envelope
// and never receive the `window.__ARCHESTRA_APP_SDK_URL__` global the proxy only
// sets for external apps — so the mute must key off the platform asset path, not
// that global, which leaked a phantom "1 runtime error" on every owned render.
describe("the sandbox proxy CSP violation filter", () => {
  const proxy = readFileSync(
    join(__dirname, "../../static/mcp-sandbox-proxy.html"),
    "utf-8",
  );

  test("mutes the platform SDK probe by asset path (owned + external apps)", () => {
    expect(proxy).toContain('indexOf("/_sandbox/ext-apps-app.js")');
    expect(proxy).toContain('indexOf("/_sandbox/archestra-app-sdk.js")');
  });

  test("does not gate the mute on the external-only SDK-URL global", () => {
    expect(proxy).not.toContain(
      "e.sourceFile === window.__ARCHESTRA_APP_SDK_URL__",
    );
  });
});

describe("buildPlatformCspContent", () => {
  test("pins the platform sandbox with absolute, origin-rooted asset URLs", () => {
    const csp = buildPlatformCspContent(
      "https://app.example.com",
      APP_PLATFORM_CSP,
    );
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Both platform scripts are allowed from the absolute origin.
    expect(csp).toContain("https://app.example.com/_sandbox/ext-apps-app.js");
    expect(csp).toContain(
      "https://app.example.com/_sandbox/archestra-app-sdk.js",
    );
    // The CDN allowlist feeds the resource directives.
    expect(csp).toContain("cdn.jsdelivr.net");
  });

  test("drops the platform asset URLs in self-contained mode", () => {
    const csp = buildPlatformCspContent(
      "https://app.example.com",
      APP_PLATFORM_CSP,
      { selfContained: true },
    );
    // The SDK and stylesheet are inline ('unsafe-inline' covers them), so the
    // resource makes no cross-origin subresource request a strict host refuses.
    expect(csp).not.toContain("/_sandbox/ext-apps-app.js");
    expect(csp).not.toContain("/_sandbox/archestra-app-sdk.js");
    // The hardening directives still hold.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
});

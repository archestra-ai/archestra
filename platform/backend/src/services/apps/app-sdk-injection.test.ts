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
import { APP_PLATFORM_CSP, ARCHESTRA_APP_SDK_SURFACE } from "./app-ui-policy";

// The injectAppSdk envelope logic moved to the app_runtime_core Rust crate; its
// behavior (anchor selection, escaping, injection order) is covered by that
// crate's table tests and the app-runtime-rs smoke test. What remains here is
// the drift guard on the static Apps SDK file the backend serves.

// Top-level keys of the `window.archestra = Object.freeze({ ... })` literal, by a
// brace-matched depth scan over the comment-stripped body (robust to reformatting,
// unlike an indentation or substring match). Only depth-0 member positions —
// shorthand `ready,` or `key:` — are collected; nested keys and value identifiers
// sit at depth > 0 and are skipped.
function sdkTopLevelMembers(sdk: string): Set<string> {
  const marker = "window.archestra = Object.freeze({";
  const open = sdk.indexOf(marker);
  if (open === -1) {
    throw new Error("SDK shape changed: window.archestra assignment not found");
  }
  const bodyStart = open + marker.length;
  let depth = 1;
  let end = bodyStart;
  for (; end < sdk.length && depth > 0; end++) {
    if (sdk[end] === "{") depth++;
    else if (sdk[end] === "}") depth--;
  }
  const body = sdk
    .slice(bodyStart, end - 1)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, "");
  const keys = new Set<string>();
  let nesting = 0;
  let atMemberStart = true;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "(" || c === "[") {
      nesting++;
      atMemberStart = false;
    } else if (c === "}" || c === ")" || c === "]") {
      nesting--;
    } else if (c === ",") {
      if (nesting === 0) atMemberStart = true;
    } else if (!/\s/.test(c)) {
      if (nesting === 0 && atMemberStart && /[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < body.length && /[\w$]/.test(body[j])) j++;
        keys.add(body.slice(i, j));
        i = j - 1;
      }
      atMemberStart = false;
    }
  }
  return keys;
}

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

  // Bidirectional on the top-level surface the lint's unknown-member check reads:
  // the allowlist must name exactly the SDK's top-level members. A new SDK member
  // the const doesn't track would otherwise make the lint false-warn on valid use
  // — the failure a one-way toContain guard misses.
  test("the allowlist names exactly the SDK's top-level members (drift guard)", () => {
    expect(sdkTopLevelMembers(sdk)).toEqual(
      new Set(ARCHESTRA_APP_SDK_SURFACE.topLevel),
    );
  });

  // Forward-only for nested members: the lint never treats a member under a valid
  // namespace as unknown (method-level typos are out of scope), so a nested add
  // can't cause a false warning — only a removal matters, which this catches.
  test("the SDK exposes every nested member the allowlist claims (drift guard)", () => {
    for (const member of [
      "window.archestra",
      ...ARCHESTRA_APP_SDK_SURFACE.storage.partitions,
      ...ARCHESTRA_APP_SDK_SURFACE.storage.methods,
      ...ARCHESTRA_APP_SDK_SURFACE.tools,
      ...ARCHESTRA_APP_SDK_SURFACE.llm,
      ...ARCHESTRA_APP_SDK_SURFACE.ui,
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

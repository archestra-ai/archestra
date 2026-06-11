import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARCHESTRA_TOOL_PREFIX,
  TOOL_APP_DATA_DELETE_SHORT_NAME,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
} from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { type AppSdkContext, injectAppSdk } from "./app-sdk-injection";

// Marker attributes the injection stamps on its <script> elements; duplicated
// from the module (not exported — production code never needs them).
const BOOTSTRAP_MARKER = "data-archestra-app-bootstrap";
const SDK_MARKER = "data-archestra-app-sdk";
const BASE_CSS_MARKER = "data-archestra-app-base-css";
// The platform stylesheet link leads the injection (first in <head>), so it sits
// where the bootstrap script used to, before it and the SDK script.
const BASE_CSS_LINK = `<link rel="stylesheet" href="/_sandbox/archestra-app-base.css" ${BASE_CSS_MARKER}>`;

const countOccurrences = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

const COMPLETE_DOC =
  "<!DOCTYPE html><html><head><title>x</title></head><body></body></html>";

const CONTEXT: AppSdkContext = {
  user: { id: "u1", name: "Alice" },
  tools: [{ name: "hf__paper_search", description: "search", inputSchema: {} }],
};

describe("the Apps SDK static file", () => {
  const sdk = readFileSync(
    join(__dirname, "../../static/archestra-app-sdk.js"),
    "utf-8",
  );

  test("dispatches the canonical app data tool names (drift guard)", () => {
    for (const shortName of [
      TOOL_APP_DATA_GET_SHORT_NAME,
      TOOL_APP_DATA_SET_SHORT_NAME,
      TOOL_APP_DATA_LIST_SHORT_NAME,
      TOOL_APP_DATA_DELETE_SHORT_NAME,
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
      "tools:",
      "ui:",
      "chat:",
      "openLink",
      "requestDisplayMode",
      "sendMessage",
    ]) {
      expect(sdk).toContain(member);
    }
  });

  test("installs runtime-error diagnostics hooks and stays eval-free", () => {
    expect(sdk).toContain("mcp-apps:runtime-error");
    for (const hook of ['"error"', '"unhandledrejection"', "console.error ="]) {
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

describe("injectAppSdk", () => {
  test("injects base stylesheet, then bootstrap, then SDK — each exactly once", () => {
    const result = injectAppSdk(COMPLETE_DOC, CONTEXT);
    expect(result).toContain(
      `<head>${BASE_CSS_LINK}<script ${BOOTSTRAP_MARKER}>`,
    );
    expect(countOccurrences(result, BASE_CSS_MARKER)).toBe(1);
    expect(countOccurrences(result, BOOTSTRAP_MARKER)).toBe(1);
    expect(countOccurrences(result, SDK_MARKER)).toBe(1);
    // base CSS leads the cascade; the SDK reads the context global at parse time
    // so the bootstrap must precede the SDK script.
    expect(result.indexOf(BASE_CSS_MARKER)).toBeLessThan(
      result.indexOf(BOOTSTRAP_MARKER),
    );
    expect(result.indexOf(BOOTSTRAP_MARKER)).toBeLessThan(
      result.indexOf(SDK_MARKER),
    );
    expect(result).toContain('src="/_sandbox/archestra-app-sdk.js"');
  });

  test("embeds the viewer identity and tool descriptors", () => {
    const result = injectAppSdk(COMPLETE_DOC, CONTEXT);
    expect(result).toContain('"user":{"id":"u1","name":"Alice"}');
    expect(result).toContain('"hf__paper_search"');
  });

  test("a display name cannot break out of the inline script", () => {
    const result = injectAppSdk(COMPLETE_DOC, {
      user: { id: "u1", name: '</script><script>alert("pwn")</script>' },
      tools: [],
    });
    // exactly the two injected scripts plus the document's own tags — the
    // payload must not contribute a real closing tag
    expect(result).not.toContain('</script><script>alert("pwn")</script>');
    expect(result).toContain("\\u003c/script\\u003e");
  });

  test("replace-substitution patterns in content are inert", () => {
    // `$&` in a string replacement re-splices the matched anchor; `$'` splices
    // the rest of the raw document — both would corrupt the bootstrap script
    const result = injectAppSdk(COMPLETE_DOC, {
      user: { id: "u1", name: "$& $' $$ $`" },
      tools: [{ name: "t", description: "costs $$$ &c.", inputSchema: {} }],
    });
    expect(result).toContain('"name":"$& $\' $$ $`"');
    expect(result).toContain('"costs $$$ &c."');
    expect(countOccurrences(result, "<head>")).toBe(1);
  });

  test("injects after uppercase <HEAD>", () => {
    const result = injectAppSdk("<HTML><HEAD></HEAD><BODY/></HTML>", CONTEXT);
    expect(result).toContain(
      `<HEAD>${BASE_CSS_LINK}<script ${BOOTSTRAP_MARKER}>`,
    );
  });

  test("injects after an attribute-bearing <head lang=...> (no duplicate head)", () => {
    const result = injectAppSdk(
      '<html lang="en"><head lang="en"></head><body/></html>',
      CONTEXT,
    );
    expect(result).toContain(
      `<head lang="en">${BASE_CSS_LINK}<script ${BOOTSTRAP_MARKER}>`,
    );
    expect(countOccurrences(result, "<head")).toBe(1);
  });

  test("<header> does not count as a head anchor", () => {
    const result = injectAppSdk("<header>nav</header><p>fragment</p>", CONTEXT);
    expect(result.startsWith(BASE_CSS_LINK)).toBe(true);
  });

  test("creates a head when only <html> exists", () => {
    const result = injectAppSdk("<html><body>hi</body></html>", CONTEXT);
    expect(result).toContain(
      `<html><head>${BASE_CSS_LINK}<script ${BOOTSTRAP_MARKER}>`,
    );
    expect(result).toContain("</script></head>");
  });

  test("anchors on the doctype when no html/head tag exists", () => {
    const result = injectAppSdk("<!DOCTYPE html><p>bare</p>", CONTEXT);
    expect(
      result.startsWith(`<!DOCTYPE html><head>${BASE_CSS_LINK}<script `),
    ).toBe(true);
    expect(result.endsWith("<p>bare</p>")).toBe(true);
  });

  test("prepends to fragment documents", () => {
    const result = injectAppSdk("<p>fragment</p>", CONTEXT);
    expect(result.startsWith(BASE_CSS_LINK)).toBe(true);
    expect(result.endsWith("<p>fragment</p>")).toBe(true);
  });

  test("a body-text mention of the marker does not suppress injection", () => {
    const result = injectAppSdk(
      `<html><head></head><body><p>${BOOTSTRAP_MARKER}</p></body></html>`,
      CONTEXT,
    );
    expect(countOccurrences(result, BOOTSTRAP_MARKER)).toBe(2);
    expect(result).toContain(
      `<head>${BASE_CSS_LINK}<script ${BOOTSTRAP_MARKER}>`,
    );
  });

  test("only the first <head> is targeted", () => {
    const result = injectAppSdk(
      "<html><head></head><body><p>&lt;head&gt;</p></body></html>",
      CONTEXT,
    );
    expect(countOccurrences(result, BOOTSTRAP_MARKER)).toBe(1);
  });
});

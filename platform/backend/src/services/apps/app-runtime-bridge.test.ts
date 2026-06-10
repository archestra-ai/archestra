import { describe, expect, test } from "vitest";
import { injectAppRuntimeBridge } from "./app-runtime-bridge";

// Marker attribute the injection stamps on its <script>; duplicated from the
// module (not exported — production code never needs it).
const MARKER = "data-archestra-runtime-bridge";

const countOccurrences = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

const COMPLETE_DOC =
  "<!DOCTYPE html><html><head><title>x</title></head><body></body></html>";

describe("the injected bridge script", () => {
  const injected = injectAppRuntimeBridge(COMPLETE_DOC);

  test("exposes the documented window.archestra contract", () => {
    for (const member of [
      "window.archestra",
      "get:",
      "set:",
      "list:",
      "delete:",
      "callTool",
      "openLink:",
      "requestDisplayMode:",
      "sendMessage:",
    ]) {
      expect(injected).toContain(member);
    }
  });

  test("dispatches the prefixed app data tools", () => {
    for (const tool of [
      "archestra__app_data_get",
      "archestra__app_data_set",
      "archestra__app_data_list",
      "archestra__app_data_delete",
    ]) {
      expect(injected).toContain(JSON.stringify(tool));
    }
  });

  test("installs runtime-error diagnostics hooks", () => {
    expect(injected).toContain("mcp-apps:runtime-error");
    for (const hook of ['"error"', '"unhandledrejection"', "console.error ="]) {
      expect(injected).toContain(hook);
    }
  });

  test("is a classic script that connects eagerly", () => {
    expect(injected).not.toContain('type="module"');
    // eager connect: the IIFE kicks off the SDK import immediately
    expect(injected).toContain("window.__ARCHESTRA_APP_SDK_URL__");
    expect(injected).toContain("PostMessageTransport");
  });
});

describe("injectAppRuntimeBridge", () => {
  test("injects exactly once, right after <head>", () => {
    const result = injectAppRuntimeBridge(COMPLETE_DOC);
    expect(result).toContain(`<head><script ${MARKER}>`);
    expect(countOccurrences(result, MARKER)).toBe(1);
  });

  test("injects after uppercase <HEAD>", () => {
    const result = injectAppRuntimeBridge("<HTML><HEAD></HEAD><BODY/></HTML>");
    expect(result).toContain(`<HEAD><script ${MARKER}>`);
  });

  test("creates a head when only <html> exists", () => {
    const result = injectAppRuntimeBridge("<html><body>hi</body></html>");
    expect(result).toContain(`<html><head><script ${MARKER}>`);
    expect(result).toContain("</script></head>");
  });

  test("anchors on the doctype when no html/head tag exists", () => {
    const result = injectAppRuntimeBridge("<!DOCTYPE html><p>bare</p>");
    expect(result).toMatch(/^<!DOCTYPE html><head><script /);
    expect(result.endsWith("<p>bare</p>")).toBe(true);
  });

  test("prepends to fragment documents", () => {
    const result = injectAppRuntimeBridge("<p>fragment</p>");
    expect(result.startsWith(`<script ${MARKER}>`)).toBe(true);
    expect(result.endsWith("<p>fragment</p>")).toBe(true);
  });

  test("a body-text mention of the marker does not suppress injection", () => {
    const result = injectAppRuntimeBridge(
      `<html><head></head><body><p>${MARKER}</p></body></html>`,
    );
    expect(countOccurrences(result, MARKER)).toBe(2);
    expect(result).toContain(`<head><script ${MARKER}>`);
  });

  test("only the first <head> is targeted", () => {
    const result = injectAppRuntimeBridge(
      "<html><head></head><body><p>&lt;head&gt;</p></body></html>",
    );
    expect(countOccurrences(result, MARKER)).toBe(1);
  });
});

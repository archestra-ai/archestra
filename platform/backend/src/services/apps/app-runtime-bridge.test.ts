import { describe, expect, test } from "vitest";
import {
  APP_RUNTIME_BRIDGE_MARKER,
  APP_RUNTIME_BRIDGE_SCRIPT,
  injectAppRuntimeBridge,
} from "./app-runtime-bridge";

const countOccurrences = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

describe("APP_RUNTIME_BRIDGE_SCRIPT", () => {
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
      expect(APP_RUNTIME_BRIDGE_SCRIPT).toContain(member);
    }
  });

  test("dispatches the prefixed app data tools", () => {
    for (const tool of [
      "archestra__app_data_get",
      "archestra__app_data_set",
      "archestra__app_data_list",
      "archestra__app_data_delete",
    ]) {
      expect(APP_RUNTIME_BRIDGE_SCRIPT).toContain(JSON.stringify(tool));
    }
  });

  test("is a classic script that connects eagerly", () => {
    expect(APP_RUNTIME_BRIDGE_SCRIPT).not.toContain('type="module"');
    // eager connect: the IIFE kicks off the SDK import immediately
    expect(APP_RUNTIME_BRIDGE_SCRIPT).toContain(
      "window.__ARCHESTRA_APP_SDK_URL__",
    );
    expect(APP_RUNTIME_BRIDGE_SCRIPT).toContain("PostMessageTransport");
  });
});

describe("injectAppRuntimeBridge", () => {
  test("injects right after <head>", () => {
    const result = injectAppRuntimeBridge(
      "<!DOCTYPE html><html><head><title>x</title></head><body></body></html>",
    );
    expect(result).toContain(`<head><script ${APP_RUNTIME_BRIDGE_MARKER}>`);
    expect(countOccurrences(result, APP_RUNTIME_BRIDGE_MARKER)).toBe(1);
  });

  test("injects after uppercase <HEAD>", () => {
    const result = injectAppRuntimeBridge("<HTML><HEAD></HEAD><BODY/></HTML>");
    expect(result).toContain(`<HEAD><script ${APP_RUNTIME_BRIDGE_MARKER}>`);
  });

  test("creates a head when only <html> exists", () => {
    const result = injectAppRuntimeBridge("<html><body>hi</body></html>");
    expect(result).toContain(
      `<html><head><script ${APP_RUNTIME_BRIDGE_MARKER}>`,
    );
    expect(result).toContain("</script></head>");
  });

  test("anchors on the doctype when no html/head tag exists", () => {
    const result = injectAppRuntimeBridge("<!DOCTYPE html><p>bare</p>");
    expect(result).toMatch(/^<!DOCTYPE html><head><script /);
    expect(result.endsWith("<p>bare</p>")).toBe(true);
  });

  test("prepends to fragment documents", () => {
    const result = injectAppRuntimeBridge("<p>fragment</p>");
    expect(result.startsWith(`<script ${APP_RUNTIME_BRIDGE_MARKER}>`)).toBe(
      true,
    );
    expect(result.endsWith("<p>fragment</p>")).toBe(true);
  });

  test("a body-text mention of the marker does not suppress injection", () => {
    const result = injectAppRuntimeBridge(
      `<html><head></head><body><p>${APP_RUNTIME_BRIDGE_MARKER}</p></body></html>`,
    );
    expect(countOccurrences(result, APP_RUNTIME_BRIDGE_MARKER)).toBe(2);
    expect(result).toContain(`<head><script ${APP_RUNTIME_BRIDGE_MARKER}>`);
  });

  test("only the first <head> is targeted", () => {
    const result = injectAppRuntimeBridge(
      "<html><head></head><body><p>&lt;head&gt;</p></body></html>",
    );
    expect(countOccurrences(result, APP_RUNTIME_BRIDGE_MARKER)).toBe(1);
  });
});

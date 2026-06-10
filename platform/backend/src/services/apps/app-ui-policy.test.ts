import { describe, expect, test } from "vitest";
import { ApiError } from "@/types";
import { buildValidatedVersionPayload } from "./app-ui-policy";

describe("buildValidatedVersionPayload", () => {
  test("absent CSP and permissions normalize to the restrictive null default", () => {
    const { payload, warnings } = buildValidatedVersionPayload({
      html: "<html><head></head><body><h1/></body></html>",
    });
    expect(payload).toEqual({
      html: "<html><head></head><body><h1/></body></html>",
      uiCsp: null,
      uiPermissions: null,
    });
    expect(warnings).toEqual([]);
  });

  test("accepts bare hostnames and single-label wildcards", () => {
    const { payload } = buildValidatedVersionPayload({
      html: "<h1/>",
      uiCsp: {
        connectDomains: ["api.example.com", "*.cdn.example.org"],
        resourceDomains: ["esm.sh"],
      },
    });
    expect(payload.uiCsp?.connectDomains).toEqual([
      "api.example.com",
      "*.cdn.example.org",
    ]);
  });

  test.each([
    ["https://example.com", "scheme prefix"],
    ["wss://example.com", "ws scheme prefix"],
    ["example.com:8443", "port"],
    ["*.*.example.com", "double wildcard"],
    ["not a domain", "spaces"],
    ["localhost", "no TLD"],
    ["*", "bare wildcard"],
  ])("rejects %s (%s)", (domain) => {
    expect(() =>
      buildValidatedVersionPayload({
        html: "<h1/>",
        uiCsp: { connectDomains: [domain] },
      }),
    ).toThrow(ApiError);
  });

  test("rejects an unknown permission key", () => {
    expect(() =>
      buildValidatedVersionPayload({
        html: "<h1/>",
        // @ts-expect-error — exercising the runtime guard against unknown keys
        uiPermissions: { usb: {} },
      }),
    ).toThrow(/unknown app permission/);
  });

  test("accepts the whitelisted permission keys", () => {
    const { payload } = buildValidatedVersionPayload({
      html: "<h1/>",
      uiPermissions: { camera: {}, clipboardWrite: {} },
    });
    expect(payload.uiPermissions).toEqual({ camera: {}, clipboardWrite: {} });
  });

  test.each([
    "__ARCHESTRA_APP_SDK_URL__",
    "PostMessageTransport",
  ])("rejects html whose <script> bootstraps the SDK (%s)", (marker) => {
    expect(() =>
      buildValidatedVersionPayload({
        html: `<html><head><script>const x = window.${marker};</script></head><body/></html>`,
      }),
    ).toThrow(/must not bootstrap the MCP App SDK/);
  });

  test("a marker mentioned outside <script> does not reject", () => {
    const { warnings } = buildValidatedVersionPayload({
      html: "<html><head></head><body><p>Docs about PostMessageTransport and __ARCHESTRA_APP_SDK_URL__.</p><!-- PostMessageTransport --></body></html>",
    });
    expect(warnings).toEqual([]);
  });

  test("a module script using window.archestra passes clean", () => {
    const { warnings } = buildValidatedVersionPayload({
      html: '<html><head><script type="module">await window.archestra.data.set("k", 1);</script></head><body/></html>',
    });
    expect(warnings).toEqual([]);
  });

  test("warns on a fragment without <head> or <html>", () => {
    const { warnings } = buildValidatedVersionPayload({
      html: "<h1>fragment</h1>",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no <head> or <html>");
  });
});

import { describe, expect, test } from "vitest";
import { ApiError } from "@/types";
import { buildValidatedVersionPayload } from "./app-ui-policy";

describe("buildValidatedVersionPayload", () => {
  test("absent CSP and permissions normalize to the restrictive null default", () => {
    const payload = buildValidatedVersionPayload({ html: "<h1/>" });
    expect(payload).toEqual({
      html: "<h1/>",
      uiCsp: null,
      uiPermissions: null,
    });
  });

  test("accepts bare hostnames and single-label wildcards", () => {
    const payload = buildValidatedVersionPayload({
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
    const payload = buildValidatedVersionPayload({
      html: "<h1/>",
      uiPermissions: { camera: {}, clipboardWrite: {} },
    });
    expect(payload.uiPermissions).toEqual({ camera: {}, clipboardWrite: {} });
  });
});

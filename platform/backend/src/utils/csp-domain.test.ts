import { describe, expect, test } from "vitest";
import { APP_PLATFORM_CSP } from "@/services/apps/app-ui-policy";
import { isCspSource } from "./csp-domain";

describe("isCspSource (serve-time, scheme/port allowed)", () => {
  test.each([
    "example.com",
    "https://example.com",
    "wss://api.example.com",
    "example.com:8443",
    "*.example.com",
    "api.v2.example.com",
    "cdn.s3.example.com",
  ])("accepts %s", (src) => {
    expect(isCspSource(src)).toBe(true);
  });

  test.each([
    "*",
    "data:",
    "blob:",
    "https:",
    "javascript:alert(1)",
    "*.*.example.com",
    "localhost",
    "ex ample.com",
    "example.com/path",
    "evil.com;script-src",
  ])("rejects dangerous source %s", (src) => {
    expect(isCspSource(src)).toBe(false);
  });

  // The platform CSP for owned apps must survive the serve-time filter intact
  // (a dropped CDN host would silently break library/font loading).
  test("every platform CDN allowlist entry is a valid CSP source", () => {
    for (const domain of APP_PLATFORM_CSP.resourceDomains ?? []) {
      expect(isCspSource(domain)).toBe(true);
    }
  });
});

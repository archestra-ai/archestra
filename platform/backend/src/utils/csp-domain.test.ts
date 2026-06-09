import { describe, expect, test } from "vitest";
import { isCspHostname, isCspSource } from "./csp-domain";

describe("isCspHostname (save-time, bare host only)", () => {
  test.each([
    "example.com",
    "api.example.com",
    "api.v2.example.com",
    "cdn.s3.example.com",
    "*.example.com",
    "a-b.example.co.uk",
  ])("accepts %s", (host) => {
    expect(isCspHostname(host)).toBe(true);
  });

  test.each([
    "https://example.com",
    "wss://example.com",
    "example.com:8443",
    "*.*.example.com",
    "localhost",
    "*",
    "ex ample.com",
    "example.com/path",
    "evil.com;script-src",
  ])("rejects %s", (host) => {
    expect(isCspHostname(host)).toBe(false);
  });
});

describe("isCspSource (serve-time, scheme/port allowed)", () => {
  test.each([
    "example.com",
    "https://example.com",
    "wss://api.example.com",
    "example.com:8443",
    "*.example.com",
    "api.v2.example.com",
  ])("accepts %s", (src) => {
    expect(isCspSource(src)).toBe(true);
  });

  // Save-time acceptance must imply serve-time acceptance (no silent drops).
  test("every host accepted on save is accepted at serve time", () => {
    for (const host of [
      "example.com",
      "api.v2.example.com",
      "cdn.s3.example.com",
      "*.example.com",
    ]) {
      expect(isCspHostname(host)).toBe(true);
      expect(isCspSource(host)).toBe(true);
    }
  });

  test.each([
    "*",
    "data:",
    "blob:",
    "https:",
    "javascript:alert(1)",
  ])("rejects dangerous source %s", (src) => {
    expect(isCspSource(src)).toBe(false);
  });
});

import { describe, expect, test } from "vitest";
import { parseSecurityMode, validateIncomingEmailSettings } from "./prompt";

describe("parseSecurityMode", () => {
  test("returns 'private' for valid private mode", () => {
    expect(parseSecurityMode("private")).toBe("private");
  });

  test("returns 'internal' for valid internal mode", () => {
    expect(parseSecurityMode("internal")).toBe("internal");
  });

  test("returns 'public' for valid public mode", () => {
    expect(parseSecurityMode("public")).toBe("public");
  });

  test("returns 'private' for undefined", () => {
    expect(parseSecurityMode(undefined)).toBe("private");
  });

  test("returns 'private' for null", () => {
    expect(parseSecurityMode(null)).toBe("private");
  });

  test("returns 'private' for unknown mode", () => {
    expect(parseSecurityMode("unknown")).toBe("private");
  });

  test("returns 'private' for empty string", () => {
    expect(parseSecurityMode("")).toBe("private");
  });

  test("returns 'private' for invalid type", () => {
    expect(parseSecurityMode("PRIVATE")).toBe("private"); // case sensitive
  });
});

describe("validateIncomingEmailSettings", () => {
  test("throws when internal mode has no allowed domain", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: null,
      }),
    ).toThrow("incomingEmailAllowedDomain is required");
  });

  test("throws when internal mode has empty allowed domain", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "",
      }),
    ).toThrow("incomingEmailAllowedDomain is required");
  });

  test("throws when internal mode has whitespace-only allowed domain", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "   ",
      }),
    ).toThrow("incomingEmailAllowedDomain is required");
  });

  test("throws when internal mode has invalid domain format - spaces", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "invalid domain",
      }),
    ).toThrow("must be a valid domain format");
  });

  test("throws when internal mode has invalid domain format - no TLD", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "company",
      }),
    ).toThrow("must be a valid domain format");
  });

  test("throws when internal mode has invalid domain format - starts with hyphen", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "-company.com",
      }),
    ).toThrow("must be a valid domain format");
  });

  test("throws when internal mode has invalid domain format - ends with hyphen", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "company-.com",
      }),
    ).toThrow("must be a valid domain format");
  });

  test("throws when internal mode has invalid domain format - single letter TLD", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "company.c",
      }),
    ).toThrow("must be a valid domain format");
  });

  test("throws when domain exceeds maximum length (253 characters)", () => {
    // Create a domain that exceeds 253 characters
    const longDomain = `${"a".repeat(250)}.com`;
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: longDomain,
      }),
    ).toThrow("exceeds maximum length of 253 characters");
  });

  test("accepts domain at maximum length (253 characters)", () => {
    // Create a domain exactly at 253 characters
    const maxLengthDomain = `${"a".repeat(249)}.com`;
    expect(maxLengthDomain.length).toBe(253);
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: maxLengthDomain,
      }),
    ).not.toThrow();
  });

  test("accepts valid simple domain", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "company.com",
      }),
    ).not.toThrow();
  });

  test("accepts valid domain with subdomain", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "sub.company.com",
      }),
    ).not.toThrow();
  });

  test("accepts valid domain with multiple subdomains", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "a.b.c.company.com",
      }),
    ).not.toThrow();
  });

  test("accepts valid domain with hyphens", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "my-company.co.uk",
      }),
    ).not.toThrow();
  });

  test("accepts valid domain with numbers", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "company123.com",
      }),
    ).not.toThrow();
  });

  test("accepts valid domain with leading/trailing whitespace (trimmed)", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "internal",
        incomingEmailAllowedDomain: "  company.com  ",
      }),
    ).not.toThrow();
  });

  test("does not validate domain for private mode", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "private",
        incomingEmailAllowedDomain: "invalid",
      }),
    ).not.toThrow();
  });

  test("does not validate domain for public mode", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailSecurityMode: "public",
        incomingEmailAllowedDomain: null,
      }),
    ).not.toThrow();
  });

  test("does not validate when security mode is not set", () => {
    expect(() =>
      validateIncomingEmailSettings({
        incomingEmailAllowedDomain: "invalid",
      }),
    ).not.toThrow();
  });
});

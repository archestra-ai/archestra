import { describe, expect, test } from "vitest";
import { validateIncomingEmailSettings } from "./agent";

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

import { describe, expect, test } from "vitest";
import {
  formatSecretStorageType,
  isBrowserMcpTool,
  isVaultReference,
  parseFullToolName,
  parseVaultReference,
  slugify,
} from "./utils";

describe("isVaultReference", () => {
  test("returns true for valid vault references", () => {
    expect(isVaultReference("secret/data/path/to/secret#keyname")).toBe(true);
  });

  test("returns false for invalid references", () => {
    expect(isVaultReference(undefined)).toBe(false);
    expect(isVaultReference("secret/data/path/to/secret")).toBe(false);
    expect(isVaultReference("short#key")).toBe(false);
  });
});

describe("parseVaultReference", () => {
  test("splits the path and key", () => {
    expect(parseVaultReference("secret/data/app#api_key")).toEqual({
      path: "secret/data/app",
      key: "api_key",
    });
  });
});

describe("formatSecretStorageType", () => {
  test("formats known storage types", () => {
    expect(formatSecretStorageType("vault")).toBe("Vault");
    expect(formatSecretStorageType("external_vault")).toBe("External Vault");
    expect(formatSecretStorageType("database")).toBe("Database");
  });

  test("falls back to None", () => {
    expect(formatSecretStorageType("none")).toBe("None");
    expect(formatSecretStorageType(undefined)).toBe("None");
  });
});

describe("slugify", () => {
  test("creates URL-safe slugs", () => {
    expect(slugify("Hello World!")).toBe("hello_world");
    expect(slugify("__Already__Slugged__")).toBe("already_slugged");
  });
});

describe("parseFullToolName", () => {
  test("standard case: server__tool", () => {
    expect(parseFullToolName("outlook-abc__send_email")).toEqual({
      serverName: "outlook-abc",
      toolName: "send_email",
    });
  });

  test("server name containing __", () => {
    expect(parseFullToolName("upstash__context7__resolve-library-id")).toEqual({
      serverName: "upstash__context7",
      toolName: "resolve-library-id",
    });
  });

  test("no separator returns null serverName", () => {
    expect(parseFullToolName("send_email")).toEqual({
      serverName: null,
      toolName: "send_email",
    });
  });
});

describe("isBrowserMcpTool", () => {
  test("matches Playwright/browser tools", () => {
    expect(
      isBrowserMcpTool("microsoft__playwright-mcp__browser_navigate"),
    ).toBe(true);
    expect(isBrowserMcpTool("browser_click")).toBe(true);
    expect(isBrowserMcpTool("github__list_issues")).toBe(false);
  });
});

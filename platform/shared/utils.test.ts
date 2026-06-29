import { describe, expect, test } from "vitest";
import {
  formatSecretStorageType,
  parseFullToolName,
  slugify,
  urlSlugify,
} from "./utils";

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

describe("urlSlugify", () => {
  test("creates hyphen-separated URL slugs", () => {
    expect(urlSlugify("Hello World!")).toBe("hello-world");
    expect(urlSlugify("My MCP Gateway")).toBe("my-mcp-gateway");
  });

  test("strips special characters", () => {
    expect(urlSlugify("Test @#$ Gateway!")).toBe("test-gateway");
    expect(urlSlugify("foo---bar")).toBe("foo-bar");
  });

  test("trims leading and trailing hyphens", () => {
    expect(urlSlugify("--Already--Slugged--")).toBe("already-slugged");
    expect(urlSlugify("  spaces  ")).toBe("spaces");
  });

  test("returns empty string for empty/symbol-only input", () => {
    expect(urlSlugify("")).toBe("");
    expect(urlSlugify("@#$%")).toBe("");
  });

  test("handles numeric names", () => {
    expect(urlSlugify("123 Test")).toBe("123-test");
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

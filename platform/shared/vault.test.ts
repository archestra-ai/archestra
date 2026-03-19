import { describe, expect, test } from "vitest";
import { isVaultReference, parseVaultReference } from "./vault";

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

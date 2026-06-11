import { describe, expect, test } from "vitest";
import { validateSandboxFolderName } from "./folder-name";

const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);

describe("validateSandboxFolderName", () => {
  test("accepts ordinary names", () => {
    expect(validateSandboxFolderName("reports")).toBeNull();
    expect(validateSandboxFolderName("Q2 Reports 2026")).toBeNull();
    expect(validateSandboxFolderName("data_v2.1-final")).toBeNull();
  });

  test("trims surrounding whitespace before validating", () => {
    expect(validateSandboxFolderName("  reports  ")).toBeNull();
  });

  test("rejects empty and whitespace-only names", () => {
    expect(validateSandboxFolderName("")).toMatch(/empty/i);
    expect(validateSandboxFolderName("   ")).toMatch(/empty/i);
  });

  test("rejects names over 128 characters", () => {
    expect(validateSandboxFolderName("a".repeat(129))).toMatch(/128/);
    expect(validateSandboxFolderName("a".repeat(128))).toBeNull();
  });

  test("rejects path separators and traversal", () => {
    expect(validateSandboxFolderName("a/b")).toMatch(/slash/i);
    expect(validateSandboxFolderName("a\\b")).toMatch(/slash/i);
    expect(validateSandboxFolderName(".")).toMatch(/dot|empty/i);
    expect(validateSandboxFolderName("..")).toMatch(/dot/i);
  });

  test("rejects leading dots (hidden / temp-file collision)", () => {
    expect(validateSandboxFolderName(".hidden")).toMatch(/dot/i);
  });

  test("rejects control characters", () => {
    expect(validateSandboxFolderName(`a${TAB}b`)).toMatch(/control/i);
    expect(validateSandboxFolderName(`a${LF}b`)).toMatch(/control/i);
    expect(validateSandboxFolderName(`a${NUL}b`)).toMatch(/control/i);
    expect(validateSandboxFolderName(`a${DEL}b`)).toMatch(/control/i);
  });
});

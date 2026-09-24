import { PROJECT_NAME_MAX_LENGTH } from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { validateProjectName } from "./project-name";

const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);

describe("validateProjectName", () => {
  test("accepts ordinary names", () => {
    expect(validateProjectName("reports")).toBeNull();
    expect(validateProjectName("Q2 Reports 2026")).toBeNull();
    expect(validateProjectName("data_v2.1-final")).toBeNull();
  });

  test("trims surrounding whitespace before validating", () => {
    expect(validateProjectName("  reports  ")).toBeNull();
  });

  test("rejects empty and whitespace-only names", () => {
    expect(validateProjectName("")).toMatch(/empty/i);
    expect(validateProjectName("   ")).toMatch(/empty/i);
  });

  test("rejects names over the max length", () => {
    expect(
      validateProjectName("a".repeat(PROJECT_NAME_MAX_LENGTH + 1)),
    ).toMatch(new RegExp(String(PROJECT_NAME_MAX_LENGTH)));
    expect(validateProjectName("a".repeat(PROJECT_NAME_MAX_LENGTH))).toBeNull();
  });

  test("rejects path separators and traversal", () => {
    expect(validateProjectName("a/b")).toMatch(/slash/i);
    expect(validateProjectName("a\\b")).toMatch(/slash/i);
    expect(validateProjectName(".")).toMatch(/dot|empty/i);
    expect(validateProjectName("..")).toMatch(/dot/i);
  });

  test("rejects leading dots (hidden / temp-file collision)", () => {
    expect(validateProjectName(".hidden")).toMatch(/dot/i);
  });

  test("rejects control characters", () => {
    expect(validateProjectName(`a${TAB}b`)).toMatch(/control/i);
    expect(validateProjectName(`a${LF}b`)).toMatch(/control/i);
    expect(validateProjectName(`a${NUL}b`)).toMatch(/control/i);
    expect(validateProjectName(`a${DEL}b`)).toMatch(/control/i);
  });
});

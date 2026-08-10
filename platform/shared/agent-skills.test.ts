import { describe, expect, it } from "vitest";
import {
  isSpecCompliantSkillCompatibility,
  isSpecCompliantSkillDescription,
  isSpecCompliantSkillName,
} from "./agent-skills";

describe("isSpecCompliantSkillName", () => {
  it.each([
    "pdf-processing",
    "a",
    "code-review-2",
    "x".repeat(64),
  ])("accepts %s", (name) => {
    expect(isSpecCompliantSkillName(name)).toBe(true);
  });

  it.each([
    "",
    "My Skill",
    "PDF-Processing",
    "-pdf",
    "pdf-",
    "pdf--processing",
    "pdf_processing",
    "café",
    "x".repeat(65),
  ])("rejects %s", (name) => {
    expect(isSpecCompliantSkillName(name)).toBe(false);
  });
});

describe("isSpecCompliantSkillDescription", () => {
  it("bounds to 1-1024 characters", () => {
    expect(isSpecCompliantSkillDescription("does the thing")).toBe(true);
    expect(isSpecCompliantSkillDescription("d".repeat(1024))).toBe(true);
    expect(isSpecCompliantSkillDescription("")).toBe(false);
    expect(isSpecCompliantSkillDescription("d".repeat(1025))).toBe(false);
  });

  it("counts code points, not UTF-16 units, matching SQL char_length", () => {
    // 1024 emoji are 2048 UTF-16 units but 1024 code points — within bounds.
    expect(isSpecCompliantSkillDescription("🙂".repeat(1024))).toBe(true);
    expect(isSpecCompliantSkillDescription(`${"🙂".repeat(1024)}!`)).toBe(
      false,
    );
  });
});

describe("isSpecCompliantSkillCompatibility", () => {
  it("bounds to 500 characters, with absent and empty both fine", () => {
    expect(isSpecCompliantSkillCompatibility(null)).toBe(true);
    expect(isSpecCompliantSkillCompatibility("")).toBe(true);
    expect(isSpecCompliantSkillCompatibility("c".repeat(500))).toBe(true);
    expect(isSpecCompliantSkillCompatibility("🙂".repeat(500))).toBe(true);
    expect(isSpecCompliantSkillCompatibility("c".repeat(501))).toBe(false);
  });
});

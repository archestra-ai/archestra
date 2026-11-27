import { describe, expect, it } from "vitest";
import {
  describeUnusableSkillDescription,
  describeUnusableSkillName,
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

describe("describeUnusableSkillDescription", () => {
  it("accepts a description within the specification's limit", () => {
    expect(describeUnusableSkillDescription("Work with PDFs.")).toBeNull();
    expect(describeUnusableSkillDescription("d".repeat(1024))).toBeNull();
    // Counted in characters, not UTF-16 units.
    expect(describeUnusableSkillDescription("🙂".repeat(1024))).toBeNull();
  });

  it("asks for a description when there is none", () => {
    expect(describeUnusableSkillDescription("  ")).toBe(
      "Give the skill a description.",
    );
  });

  it("refuses a description over the limit, and states the limit", () => {
    expect(describeUnusableSkillDescription("d".repeat(1025))).toBe(
      "This description is too long. Skill description can be up to 1024 characters.",
    );
  });
});

describe("describeUnusableSkillName", () => {
  it.each([
    "pdf-processing",
    "a",
    "v2",
    "x".repeat(64),
  ])("accepts %s", (name) => {
    expect(describeUnusableSkillName(name)).toBeNull();
  });

  it.each([
    ["", "Give the skill a name."],
    ["   ", "Give the skill a name."],
  ])("asks for a name when given %j", (name, message) => {
    expect(describeUnusableSkillName(name)).toBe(message);
  });

  // Anything the Agent Skills naming rules refuse gets the one sentence that
  // states the rules, whatever the name got wrong.
  it.each([
    "My Skill",
    "PDF-Tools",
    "pdf_tools",
    "résumé",
    "notes ✍️",
    "a/b",
    "a\\b",
    "two\nlines",
    ".",
    "up..and-over",
    "-pdf",
    "pdf-",
    "pdf--tools",
    "x".repeat(65),
  ])("refuses %j", (name) => {
    expect(describeUnusableSkillName(name)).toBe(
      "This name can't be used. Skill name can only contain lowercase letters, digits and single hyphens, up to 64 characters.",
    );
  });
});

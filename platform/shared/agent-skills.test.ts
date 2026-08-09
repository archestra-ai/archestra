import { describe, expect, it } from "vitest";
import { isSpecCompliantSkillName } from "./agent-skills";

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

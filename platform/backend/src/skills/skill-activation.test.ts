import { describe, expect, test } from "@/test";
import { formatSkillActivation } from "./skill-activation";

describe("formatSkillActivation", () => {
  test("wraps the skill body in a skill_content tag", () => {
    const result = formatSkillActivation({
      skill: { name: "Research", content: "Do research.", compatibility: null },
      files: [],
    });

    expect(result).toBe(
      '<skill_content name="Research">\nDo research.\n</skill_content>',
    );
  });

  test("appends compatibility and resource listing when present", () => {
    const result = formatSkillActivation({
      skill: { name: "Research", content: "Body", compatibility: "Python 3" },
      files: [
        { path: "references/REF.md", kind: "reference" },
        { path: "scripts/run.py", kind: "script" },
      ],
    });

    expect(result).toContain(
      "<skill_compatibility>Python 3</skill_compatibility>",
    );
    expect(result).toContain("references/REF.md (reference)");
    expect(result).toContain("scripts/run.py (script)");
  });

  test("escapes XML-significant characters in names and paths", () => {
    const result = formatSkillActivation({
      skill: { name: "A & B <c>", content: "x", compatibility: null },
      files: [{ path: "refs/<a>.md", kind: "reference" }],
    });

    expect(result).toContain('name="A &amp; B &lt;c&gt;"');
    expect(result).toContain("refs/&lt;a&gt;.md (reference)");
  });
});

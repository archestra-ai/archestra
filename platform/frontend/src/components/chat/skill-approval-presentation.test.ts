// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getSkillApprovalView } from "./skill-approval-presentation";

const manifest =
  "---\nname: example-skill\ndescription: A review example.\n---\n\n# Instructions\n\nKeep the complete request visible.";

describe("getSkillApprovalView", () => {
  it("separates metadata from instructions without changing the original payload", () => {
    const raw = JSON.stringify({ content: manifest }, null, 4);
    expect(getSkillApprovalView("create_skill", raw)).toEqual({
      name: "example-skill",
      description: "A review example.",
      instructions: "# Instructions\n\nKeep the complete request visible.",
      originalArguments: raw,
    });
  });

  it("parses quoted names, folded descriptions, BOMs, and Windows line endings", () => {
    const content = [
      "\uFEFF---",
      'name: "example-skill"',
      "description: >-",
      "  Review a skill:",
      "  keep all its fields.",
      "---",
      "",
      "Instructions.",
    ].join("\r\n");
    expect(
      getSkillApprovalView("create_skill", JSON.stringify({ content })),
    ).toMatchObject({
      name: "example-skill",
      description: "Review a skill: keep all its fields.",
      instructions: "Instructions.",
    });
  });

  it("keeps additional metadata, files, and sharing arguments in the review", () => {
    const files = [{ path: "references/example.md", content: "Reference." }];
    const initialGrants = [{ subjectType: "user", subjectId: "example-user" }];
    const raw = JSON.stringify({
      content: manifest.replace(
        "description: A review example.",
        "description: A review example.\nallowed-tools: [Read, Write]\ntemplated: true\nmetadata:\n  owner: example-team",
      ),
      files,
      initialGrants,
    });
    const view = getSkillApprovalView("create_skill", raw);
    expect(JSON.parse(view?.metadata ?? "{}")).toEqual({
      "allowed-tools": ["Read", "Write"],
      templated: true,
      metadata: { owner: "example-team" },
    });
    expect(JSON.parse(view?.additionalArguments ?? "{}")).toEqual({
      files,
      initialGrants,
    });
    expect(view?.originalArguments).toBe(raw);
  });

  it("distinguishes the current skill name from the proposed name on updates", () => {
    const raw = JSON.stringify({ name: "old-skill", content: manifest });
    expect(getSkillApprovalView("update_skill", raw)).toMatchObject({
      currentName: "old-skill",
      name: "example-skill",
      originalArguments: raw,
    });
    expect(
      getSkillApprovalView(
        "update_skill",
        JSON.stringify({ content: manifest }),
      ),
    ).toBeNull();
  });

  it("leaves unrelated tools with manifest-like arguments in the generic view", () => {
    const raw = JSON.stringify({ content: manifest });
    expect(getSkillApprovalView("save_file", raw)).toBeNull();
    expect(getSkillApprovalView(null, raw)).toBeNull();
  });

  it.each([
    "not JSON",
    "[]",
    JSON.stringify({ content: null }),
    JSON.stringify({ content: "# No frontmatter" }),
    JSON.stringify({ content: "---\n- name\n- description\n---\nBody" }),
    JSON.stringify({ content: "---\nname: example-skill\n---\nBody" }),
    JSON.stringify({
      content: "---\nname: first\nname: second\ndescription: Review\n---\nBody",
    }),
    JSON.stringify({
      content: "---\nname: true\ndescription: Review\n---\nBody",
    }),
    JSON.stringify({
      content:
        "---\nname: example-skill\ndescription: Review\nmetadata: &self\n  recursive: *self\n---\nBody",
    }),
  ])("falls back to the original request for unsupported input: %s", (raw) => {
    expect(getSkillApprovalView("create_skill", raw)).toBeNull();
  });
});

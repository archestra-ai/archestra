import { describe, expect, it } from "vitest";
import { type SkillIndexEntry, searchSkillIndexEntries } from "./skill-index";

describe("searchSkillIndexEntries", () => {
  it("ranks skill name matches above repo and description matches", () => {
    const results = searchSkillIndexEntries({
      entries: [
        skill({
          name: "Workflow Builder",
          description: "Design policy workflows for agents.",
          repoStars: 10_000,
        }),
        skill({
          name: "Policy Designer",
          description: "Write safe tool invocation rules.",
          repoStars: 10,
        }),
        skill({
          repo: "acme/policy-tools",
          name: "Access Helper",
          description: "Map teams to agent tools.",
          repoStars: 50_000,
        }),
      ],
      query: "policy",
    });

    expect(results.map((result) => result.name)).toEqual([
      "Policy Designer",
      "Access Helper",
      "Workflow Builder",
    ]);
  });

  it("requires every search token to match", () => {
    const results = searchSkillIndexEntries({
      entries: [
        skill({
          name: "Policy Designer",
          description: "Write safe tool invocation rules.",
        }),
        skill({
          name: "Workflow Builder",
          description: "Design policy workflows for agents.",
        }),
      ],
      query: "policy workflow",
    });

    expect(results.map((result) => result.name)).toEqual(["Workflow Builder"]);
  });
});

function skill(overrides: Partial<SkillIndexEntry>): SkillIndexEntry {
  return {
    repo: "acme/skills",
    repoDescription: "Example skill repository.",
    repoStars: 1,
    skillPath: `skills/${overrides.name?.toLowerCase().replaceAll(" ", "-") ?? "test"}`,
    name: "Test Skill",
    description: "Example description.",
    compatibility: null,
    fileCount: 0,
    sourceRef: "acme/skills@main:skills/test",
    ...overrides,
  };
}

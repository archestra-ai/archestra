import { describe, expect, it } from "vitest";
import { type SkillIndexEntry, searchSkillIndexEntries } from "./skill-index";

describe("searchSkillIndexEntries", () => {
  it("ranks skill name matches above repo and description matches", () => {
    const results = searchSkillIndexEntries({
      entries: [
        skill({
          name: "Workflow Builder",
          description: "Design policy workflows for agents.",
        }),
        skill({
          name: "Policy Designer",
          description: "Write safe tool invocation rules.",
        }),
        skill({
          repo: "acme/policy-tools",
          name: "Access Helper",
          description: "Map teams to agent tools.",
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

  it("matches token prefixes", () => {
    const results = searchSkillIndexEntries({
      entries: [
        skill({ name: "Workflow Builder" }),
        skill({ name: "Policy Designer" }),
      ],
      query: "work",
    });

    expect(results.map((result) => result.name)).toEqual(["Workflow Builder"]);
  });

  it("ignores stop words in the query", () => {
    const results = searchSkillIndexEntries({
      entries: [
        skill({
          name: "Policy Designer",
          description: "Write safe tool invocation rules.",
        }),
      ],
      query: "the policy",
    });

    expect(results.map((result) => result.name)).toEqual(["Policy Designer"]);
  });

  it("returns nothing for an all-stop-word query", () => {
    const results = searchSkillIndexEntries({
      entries: [skill({ name: "Policy Designer" })],
      query: "the and of",
    });

    expect(results).toEqual([]);
  });
});

function skill(overrides: Partial<SkillIndexEntry>): SkillIndexEntry {
  return {
    repo: "acme/skills",
    repoDescription: "Example skill repository.",
    skillPath: `skills/${overrides.name?.toLowerCase().replaceAll(" ", "-") ?? "test"}`,
    name: "Test Skill",
    description: "Example description.",
    compatibility: null,
    fileCount: 0,
    ...overrides,
  };
}

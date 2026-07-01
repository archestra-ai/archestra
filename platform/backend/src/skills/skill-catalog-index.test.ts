import { describe, expect, it } from "vitest";
import {
  buildSkillCatalogIndex,
  dedupeSkillCatalogEntries,
  type SkillCatalogEntry,
  searchSkillCatalogIndex,
} from "./skill-catalog-index";

describe("dedupeSkillCatalogEntries", () => {
  it("collapses identical skills mirrored across paths and repos", () => {
    const deduped = dedupeSkillCatalogEntries([
      skill({
        repo: "microsoft/azure-skills",
        name: "azure-cloud-migrate",
        description: "Migrate workloads to Azure.",
        skillPath: ".github/plugins/azure-skills/skills/azure-cloud-migrate",
      }),
      skill({
        repo: "microsoft/azure-skills",
        name: "azure-cloud-migrate",
        description: "Migrate workloads to Azure.",
        skillPath: "skills/azure-cloud-migrate",
      }),
      skill({
        repo: "microsoft/skills",
        name: "azure-cloud-migrate",
        description: "Migrate workloads to Azure.",
        skillPath: ".github/plugins/azure-skills/skills/azure-cloud-migrate",
      }),
    ]);

    expect(deduped).toHaveLength(1);
    // shallowest path wins as the canonical copy
    expect(deduped[0].skillPath).toBe("skills/azure-cloud-migrate");
  });

  it("keeps same-name skills that have different descriptions", () => {
    const deduped = dedupeSkillCatalogEntries([
      skill({ name: "code-review", description: "Review engineering diffs." }),
      skill({ name: "code-review", description: "Review Flutter widgets." }),
    ]);

    expect(deduped).toHaveLength(2);
  });
});

describe("searchSkillCatalogIndex", () => {
  it("ranks skill name matches above repo and description matches", () => {
    const results = search(
      [
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
      "policy",
    );

    expect(results.map((result) => result.name)).toEqual([
      "Policy Designer",
      "Access Helper",
      "Workflow Builder",
    ]);
  });

  it("requires every search token to match", () => {
    const results = search(
      [
        skill({
          name: "Policy Designer",
          description: "Write safe tool invocation rules.",
        }),
        skill({
          name: "Workflow Builder",
          description: "Design policy workflows for agents.",
        }),
      ],
      "policy workflow",
    );

    expect(results.map((result) => result.name)).toEqual(["Workflow Builder"]);
  });

  it("matches token prefixes", () => {
    const results = search(
      [skill({ name: "Workflow Builder" }), skill({ name: "Policy Designer" })],
      "work",
    );

    expect(results.map((result) => result.name)).toEqual(["Workflow Builder"]);
  });

  it("ignores stop words in the query", () => {
    const results = search(
      [
        skill({
          name: "Policy Designer",
          description: "Write safe tool invocation rules.",
        }),
      ],
      "the policy",
    );

    expect(results.map((result) => result.name)).toEqual(["Policy Designer"]);
  });

  it("returns nothing for an all-stop-word query", () => {
    const results = search([skill({ name: "Policy Designer" })], "the and of");

    expect(results).toEqual([]);
  });
});

function search(
  entries: readonly SkillCatalogEntry[],
  query: string,
): SkillCatalogEntry[] {
  return searchSkillCatalogIndex(buildSkillCatalogIndex(entries), query);
}

function skill(overrides: Partial<SkillCatalogEntry>): SkillCatalogEntry {
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

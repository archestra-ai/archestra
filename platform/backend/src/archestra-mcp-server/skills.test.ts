// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  TOOL_ACTIVATE_SKILL_FULL_NAME,
  TOOL_LIST_SKILLS_FULL_NAME,
  TOOL_READ_SKILL_FILE_FULL_NAME,
} from "@shared";
import { SkillModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent, InsertSkill, InsertSkillFile } from "@/types";
import {
  type ArchestraContext,
  executeArchestraTool,
  getArchestraMcpTools,
} from ".";

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as any).text as string;
}

describe("skill tool execution", () => {
  let agent: Agent;
  let context: ArchestraContext;
  let organizationId: string;

  beforeEach(async ({ makeAgent }) => {
    agent = await makeAgent({ name: "Skill Agent" });
    organizationId = agent.organizationId;
    context = {
      agent: { id: agent.id, name: agent.name },
      organizationId,
    };
  });

  async function seedSkill(
    overrides: {
      skill?: Partial<InsertSkill>;
      files?: Omit<InsertSkillFile, "skillId">[];
    } = {},
  ) {
    return await SkillModel.createWithFiles({
      skill: {
        organizationId,
        name: "pdf-processing",
        description: "Extract text from PDF files.",
        content: "# PDF Processing\nUse pdftotext.",
        metadata: {},
        sourceType: "manual",
        ...overrides.skill,
      },
      files: overrides.files ?? [],
    });
  }

  test("all three skill tools are registered as Archestra tools", () => {
    const names = getArchestraMcpTools().map((tool) => tool.name);
    expect(names).toContain(TOOL_LIST_SKILLS_FULL_NAME);
    expect(names).toContain(TOOL_ACTIVATE_SKILL_FULL_NAME);
    expect(names).toContain(TOOL_READ_SKILL_FILE_FULL_NAME);
  });

  test("list_skills lists the org catalog", async () => {
    await seedSkill();
    const result = await executeArchestraTool(
      TOOL_LIST_SKILLS_FULL_NAME,
      {},
      context,
    );

    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain("<available_skills>");
    expect(textOf(result)).toContain("pdf-processing");
  });

  test("list_skills reports when the org has no skills", async () => {
    const result = await executeArchestraTool(
      TOOL_LIST_SKILLS_FULL_NAME,
      {},
      context,
    );

    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain("No skills are available");
  });

  test("activate_skill with a name returns the SKILL.md body and resources", async () => {
    await seedSkill({
      files: [
        { path: "references/FORMS.md", content: "# Forms", kind: "reference" },
      ],
    });
    const result = await executeArchestraTool(
      TOOL_ACTIVATE_SKILL_FULL_NAME,
      { name: "pdf-processing" },
      context,
    );

    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain("# PDF Processing");
    expect(textOf(result)).toContain("references/FORMS.md (reference)");
  });

  test("activate_skill surfaces the compatibility requirement", async () => {
    await seedSkill({ skill: { compatibility: "requires python3" } });
    const result = await executeArchestraTool(
      TOOL_ACTIVATE_SKILL_FULL_NAME,
      { name: "pdf-processing" },
      context,
    );

    expect(textOf(result)).toContain("requires python3");
  });

  test("activate_skill errors on an unknown skill", async () => {
    const result = await executeArchestraTool(
      TOOL_ACTIVATE_SKILL_FULL_NAME,
      { name: "does-not-exist" },
      context,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("does-not-exist");
  });

  test("read_skill_file returns a bundled resource file", async () => {
    await seedSkill({
      files: [
        { path: "references/FORMS.md", content: "# Forms", kind: "reference" },
      ],
    });
    const result = await executeArchestraTool(
      TOOL_READ_SKILL_FILE_FULL_NAME,
      { skill: "pdf-processing", path: "references/FORMS.md" },
      context,
    );

    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain("# Forms");
  });

  test("read_skill_file errors on a missing file", async () => {
    await seedSkill();
    const result = await executeArchestraTool(
      TOOL_READ_SKILL_FILE_FULL_NAME,
      { skill: "pdf-processing", path: "references/MISSING.md" },
      context,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("MISSING.md");
  });
});

import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import { EnvironmentModel, SkillModel } from "@/models";
import { afterAll, beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { buildSkillCatalogPrompt } from "./skill-catalog-prompt";

/**
 * Characterization of the `<available_skills>` block and its activation
 * instructions — the runtime model-facing surface that the static
 * tool-text snapshot does not reach. Snapshots pin the exact wording so a
 * drift from the skill terminology glossary fails CI; a fixed skill keeps the
 * per-skill data line stable.
 */
async function seedSkill(organizationId: string) {
  return await SkillModel.createWithFiles({
    skill: {
      organizationId,
      name: "pdf-processing",
      description: "Extract text from PDF files.",
      content: "# PDF Processing\nUse pdftotext.",
      metadata: {},
      sourceType: "manual",
      scope: "org",
    },
    files: [],
  });
}

describe("buildSkillCatalogPrompt (sandbox unavailable)", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;

  beforeEach(async ({ makeAgent, makeUser, makeMember }) => {
    agent = await makeAgent({ name: "Skill Agent" });
    organizationId = agent.organizationId;
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    userId = user.id;
  });

  test("pins the catalog block and base activation instruction", async () => {
    await seedSkill(organizationId);
    const prompt = await buildSkillCatalogPrompt({
      organizationId,
      userId,
      agentId: agent.id,
    });
    expect(prompt).toMatchSnapshot();
  });

  test("returns null when the caller has no accessible skills", async () => {
    const prompt = await buildSkillCatalogPrompt({
      organizationId,
      userId,
      agentId: agent.id,
    });
    expect(prompt).toBeNull();
  });
});

describe("buildSkillCatalogPrompt (sandbox available)", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;
  const originalEnabled = config.skillsSandbox.enabled;

  beforeEach(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
  });

  afterAll(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = originalEnabled;
  });

  beforeEach(
    async ({
      makeAgent,
      makeUser,
      makeMember,
      seedAndAssignArchestraTools,
    }) => {
      agent = await makeAgent({ name: "Skill Agent" });
      organizationId = agent.organizationId;
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
      userId = user.id;
      // Assign the sandbox tools (seeded with the runtime enabled) so the
      // catalog advertises the sandbox path.
      await seedAndAssignArchestraTools(agent.id);
    },
  );

  test("pins the catalog block and sandbox activation instruction", async () => {
    await seedSkill(organizationId);
    const prompt = await buildSkillCatalogPrompt({
      organizationId,
      userId,
      agentId: agent.id,
    });
    expect(prompt).toMatchSnapshot();
  });
});

describe("buildSkillCatalogPrompt environment scoping", () => {
  test("hides environment-assigned skills elsewhere; unassigned and built-in skills are visible everywhere", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const defaultEnvAgent = await makeAgent({ name: "Default Env Agent" });
    const organizationId = defaultEnvAgent.organizationId;
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    const otherEnv = await EnvironmentModel.create({
      organizationId,
      name: "Other Environment",
    });
    const otherEnvAgent = await makeAgent({
      name: "Other Env Agent",
      organizationId,
      environmentId: otherEnv.id,
    });

    await SkillModel.createWithFiles({
      skill: {
        organizationId,
        name: "default-env-skill",
        description: "Has no environment assignments (available everywhere).",
        content: "Default env instructions.",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });
    await SkillModel.createWithFiles({
      skill: {
        organizationId,
        name: "other-env-skill",
        description: "Lives in the other environment.",
        content: "Other env instructions.",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
      environmentIds: [otherEnv.id],
    });
    // built-in skills are exempt from environment isolation, mirroring the
    // built-in catalog exemption on tools.
    await SkillModel.createWithFiles({
      skill: {
        organizationId,
        name: "built-in-skill",
        description: "Shipped by the platform.",
        content: "Built-in instructions.",
        metadata: {},
        sourceType: "built_in",
        sourceRef: "built-in-skill",
        scope: "org",
      },
      files: [],
    });

    const defaultCatalog = await buildSkillCatalogPrompt({
      organizationId,
      userId: user.id,
      agentId: defaultEnvAgent.id,
    });
    expect(defaultCatalog).toContain("default-env-skill");
    expect(defaultCatalog).toContain("built-in-skill");
    expect(defaultCatalog).not.toContain("other-env-skill");

    const otherCatalog = await buildSkillCatalogPrompt({
      organizationId,
      userId: user.id,
      agentId: otherEnvAgent.id,
    });
    expect(otherCatalog).toContain("other-env-skill");
    expect(otherCatalog).toContain("built-in-skill");
    // a skill with no environment assignments is available everywhere,
    // including environments other than the Default one.
    expect(otherCatalog).toContain("default-env-skill");
  });
});

describe("buildSkillCatalogPrompt agent-designated skills", () => {
  test("annotates agent-designated skills and steers to the skill__ tool", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({ name: "Skill Agent" });
    const organizationId = agent.organizationId;
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    await SkillModel.createWithFiles({
      skill: {
        organizationId,
        name: "deep-research",
        description: "Multi-step research.",
        content: "Research thoroughly.",
        agentName: "Research Bot",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });

    const prompt = await buildSkillCatalogPrompt({
      organizationId,
      userId: user.id,
      agentId: agent.id,
    });
    expect(prompt).toContain(
      '<skill name="deep-research" agent="Research Bot">',
    );
    expect(prompt).toContain("runs in that subagent");
    expect(prompt).toContain("skill__<name> tool");
  });
});

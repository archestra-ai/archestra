import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import { SkillModel } from "@/models";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
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

  beforeAll(() => {
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

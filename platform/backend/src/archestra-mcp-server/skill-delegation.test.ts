// biome-ignore-all lint/suspicious/noExplicitAny: test
import { SKILL_TOOL_PREFIX } from "@archestra/shared";
import { vi } from "vitest";
import { EnvironmentModel, SkillModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { InsertSkill } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { getSkillDelegationTools } from "./skill-delegation";

const mockExecuteA2AMessage = vi.fn();

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: (...args: unknown[]) => mockExecuteA2AMessage(...args),
}));

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as any).text as string;
}

describe("skill delegation (agent-designated skills)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A parent agent, a member caller, an org-scoped delegation target named
  // "Research Bot", and an org-scoped skill designating it.
  async function setup(fixtures: {
    makeOrganization: any;
    makeUser: any;
    makeMember: any;
    makeAgent: any;
  }) {
    const { makeOrganization, makeUser, makeMember, makeAgent } = fixtures;
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "member" });
    const parent = await makeAgent({
      name: "Parent Agent",
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
    });
    const target = await makeAgent({
      name: "Research Bot",
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
    });
    const skill = await seedSkill(organization.id, {
      agentName: "Research Bot",
    });
    const context: ArchestraContext = {
      agent: { id: parent.id, name: parent.name },
      agentId: parent.id,
      organizationId: organization.id,
      userId: user.id,
    };
    return { organization, user, parent, target, skill, context };
  }

  async function seedSkill(
    organizationId: string,
    overrides: Partial<InsertSkill> & { environmentIds?: string[] } = {},
  ) {
    const { environmentIds, ...skillOverrides } = overrides;
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId,
        name: "deep-research",
        description: "Multi-step research with citations.",
        content: "Research thoroughly. Cite sources.",
        metadata: {},
        sourceType: "manual",
        scope: "org",
        ...skillOverrides,
      },
      files: [],
      environmentIds,
    });
    if (!skill) throw new Error("failed to seed skill");
    return skill;
  }

  test("surfaces a skill__ tool for an accessible agent-designated skill", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, user, parent, target } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });
    // a skill without a designated agent never becomes a delegation tool
    await seedSkill(organization.id, { name: "inline-skill" });

    const tools = await getSkillDelegationTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: user.id,
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe(`${SKILL_TOOL_PREFIX}deep_research`);
    expect(tools[0].description).toContain('"deep-research"');
    expect(tools[0].description).toContain('"Research Bot"');
    expect(tools[0]._meta).toMatchObject({ targetAgentId: target.id });
  });

  test("returns no tools without a real signed-in user", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, parent } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });

    for (const userId of [undefined, "system"]) {
      const tools = await getSkillDelegationTools({
        agentId: parent.id,
        organizationId: organization.id,
        userId,
      });
      expect(tools).toEqual([]);
    }
  });

  test("omits a skill whose designated agent does not resolve", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, user, parent } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });
    await SkillModel.createWithFiles({
      skill: {
        organizationId: organization.id,
        name: "orphan-skill",
        description: "Designates a nonexistent agent.",
        content: "Do things.",
        agentName: "Nonexistent Bot",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });

    const tools = await getSkillDelegationTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: user.id,
    });
    expect(tools.map((t) => t.name)).toEqual([
      `${SKILL_TOOL_PREFIX}deep_research`,
    ]);
  });

  test("never crosses environment boundaries (skill and target, surface and dispatch)", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, user, parent } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });
    const otherEnv = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Other Environment",
    });
    // a skill living in another environment is invisible from the Default env
    await seedSkill(organization.id, {
      name: "cross-env-skill",
      agentName: "Research Bot",
      environmentIds: [otherEnv.id],
    });
    // ...and a Default-env skill designating a cross-environment agent has no
    // resolvable target, so it is not advertised either.
    await makeAgent({
      name: "Cross Env Bot",
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      environmentId: otherEnv.id,
    });
    await seedSkill(organization.id, {
      name: "cross-env-target-skill",
      agentName: "Cross Env Bot",
    });

    const tools = await getSkillDelegationTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: user.id,
    });
    expect(tools.map((t) => t.name)).toEqual([
      `${SKILL_TOOL_PREFIX}deep_research`,
    ]);

    for (const slug of ["cross_env_skill", "cross_env_target_skill"]) {
      const result = await executeArchestraTool(
        `${SKILL_TOOL_PREFIX}${slug}`,
        { message: "go" },
        {
          agent: { id: parent.id, name: parent.name },
          agentId: parent.id,
          organizationId: organization.id,
          userId: user.id,
        },
      );
      expect(result.isError).toBe(true);
    }
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("dispatches the skill instructions plus the task to the designated agent", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { target, context } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });
    mockExecuteA2AMessage.mockResolvedValue({ text: "research complete" });

    const result = await executeArchestraTool(
      `${SKILL_TOOL_PREFIX}deep_research`,
      { message: "find prior art for widgets" },
      context,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("research complete");
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
    const params = mockExecuteA2AMessage.mock.calls[0][0];
    expect(params.agentId).toBe(target.id);
    expect(params.userId).toBe(context.userId);
    // the subagent receives the rendered activation block plus the caller's task
    expect(params.message).toContain(
      '<skill_content name="deep-research" version="1">',
    );
    expect(params.message).toContain("Research thoroughly. Cite sources.");
    expect(params.message).toContain("find prior art for widgets");
    expect(params.parentDelegationChain).toBe(context.agentId);
  });

  test("refuses dispatch for an unknown skill slug and for automated runs", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { context } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });

    const unknown = await executeArchestraTool(
      `${SKILL_TOOL_PREFIX}nope`,
      { message: "go" },
      context,
    );
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("No skill delegation is configured");

    const system = await executeArchestraTool(
      `${SKILL_TOOL_PREFIX}deep_research`,
      { message: "go" },
      { ...context, userId: "system" },
    );
    expect(system.isError).toBe(true);
    expect(textOf(system)).toContain("requires a signed-in user");
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("hides a skill whose designated agent the caller cannot access", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organization, user, parent } = await setup({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });
    // a personal agent owned by someone else is not an accessible delegation
    // target for a plain member
    const outsider = await makeUser();
    await makeMember(outsider.id, organization.id, { role: "member" });
    await makeAgent({
      name: "Private Bot",
      agentType: "agent",
      organizationId: organization.id,
      scope: "personal",
      authorId: outsider.id,
    });
    await seedSkill(organization.id, {
      name: "private-target-skill",
      agentName: "Private Bot",
    });

    const tools = await getSkillDelegationTools({
      agentId: parent.id,
      organizationId: organization.id,
      userId: user.id,
    });
    expect(tools.map((t) => t.name)).toEqual([
      `${SKILL_TOOL_PREFIX}deep_research`,
    ]);

    const result = await executeArchestraTool(
      `${SKILL_TOOL_PREFIX}private_target_skill`,
      { message: "go" },
      {
        agent: { id: parent.id, name: parent.name },
        agentId: parent.id,
        organizationId: organization.id,
        userId: user.id,
      },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not available");
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });
});

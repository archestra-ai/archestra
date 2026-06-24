import { ADMIN_ROLE_NAME, TOOL_LOAD_SKILL_SHORT_NAME } from "@archestra/shared";
import type { Tool } from "ai";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { SkillModel } from "@/models";
import { describe, expect, test } from "@/test";
import {
  buildAgentSystemPrompt,
  PROJECT_INSTRUCTIONS_PREFIX,
  TOOL_DENIAL_INSTRUCTION,
  TOOL_UI_RESULT_INSTRUCTION,
} from "./agent-system-prompt";

const loadSkillToolName = archestraMcpBranding.getToolName(
  TOOL_LOAD_SKILL_SHORT_NAME,
);
const someTool: Record<string, Tool> = { some_tool: {} as Tool };
const withLoadSkill: Record<string, Tool> = { [loadSkillToolName]: {} as Tool };

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

describe("buildAgentSystemPrompt", () => {
  test("passes the base prompt through and always appends the denial instruction", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({
      systemPrompt: "You are helpful.",
      toolExposureMode: "full",
    });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);

    const prompt = await buildAgentSystemPrompt({
      agent,
      mcpTools: {},
      organizationId: agent.organizationId,
      userId: user.id,
      agentId: agent.id,
    });

    expect(prompt).toBe(`You are helpful.\n\n${TOOL_DENIAL_INSTRUCTION}`);
  });

  test("renders Handlebars user context from a fetched user and their teams", async ({
    makeAgent,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const agent = await makeAgent({
      systemPrompt: "Hi {{user.name}} <{{user.email}}>. Teams: {{user.teams}}.",
      toolExposureMode: "full",
    });
    const user = await makeUser({ email: "alice@test.com" });
    await makeMember(user.id, agent.organizationId);
    const team = await makeTeam(agent.organizationId, user.id, {
      name: "Platform",
    });
    await makeTeamMember(team.id, user.id);

    const prompt = await buildAgentSystemPrompt({
      agent,
      mcpTools: {},
      organizationId: agent.organizationId,
      userId: user.id,
      agentId: agent.id,
    });

    expect(prompt).toContain("<alice@test.com>.");
    expect(prompt).toContain("Teams: Platform.");
  });

  test("includes the skill catalog only when the load-skill tool is present", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({
      systemPrompt: "Base.",
      toolExposureMode: "full",
    });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId, { role: ADMIN_ROLE_NAME });
    await seedSkill(agent.organizationId);

    const withCatalog = await buildAgentSystemPrompt({
      agent,
      mcpTools: withLoadSkill,
      organizationId: agent.organizationId,
      userId: user.id,
      agentId: agent.id,
    });
    expect(withCatalog).toContain("<available_skills>");
    expect(withCatalog).toContain("pdf-processing");

    const withoutCatalog = await buildAgentSystemPrompt({
      agent,
      mcpTools: someTool,
      organizationId: agent.organizationId,
      userId: user.id,
      agentId: agent.id,
    });
    expect(withoutCatalog).not.toContain("<available_skills>");
  });

  test("adds the sandbox fallback instruction only when the sandbox is usable", async ({
    makeAgent,
    makeUser,
    makeMember,
    makeCustomRole,
    seedAndAssignArchestraTools,
  }) => {
    const config = (await import("@/config")).default;
    const originalEnabled = config.skillsSandbox.enabled;
    (config.skillsSandbox as { enabled: boolean }).enabled = true;

    try {
      const agent = await makeAgent({
        systemPrompt: "Base.",
        toolExposureMode: "full",
      });
      const user = await makeUser();
      const role = await makeCustomRole(agent.organizationId, {
        permission: { sandbox: ["execute"] },
      });
      await makeMember(user.id, agent.organizationId, { role: role.role });
      await seedAndAssignArchestraTools(agent.id);

      const withSandbox = await buildAgentSystemPrompt({
        agent,
        mcpTools: {},
        organizationId: agent.organizationId,
        userId: user.id,
        agentId: agent.id,
      });
      expect(withSandbox).toContain("code execution environment");

      // the same agent gets no instruction once the sandbox is disabled on the
      // deployment, even with the tools assigned and the permission granted
      (config.skillsSandbox as { enabled: boolean }).enabled = false;
      const withoutSandbox = await buildAgentSystemPrompt({
        agent,
        mcpTools: {},
        organizationId: agent.organizationId,
        userId: user.id,
        agentId: agent.id,
      });
      expect(withoutSandbox).not.toContain("code execution environment");
    } finally {
      (config.skillsSandbox as { enabled: boolean }).enabled = originalEnabled;
    }
  });

  test("adds the tool-result instruction only when tools are present", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({
      systemPrompt: "Base.",
      toolExposureMode: "full",
    });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    const common = {
      agent,
      organizationId: agent.organizationId,
      userId: user.id,
      agentId: agent.id,
    };

    expect(
      await buildAgentSystemPrompt({ ...common, mcpTools: someTool }),
    ).toContain(TOOL_UI_RESULT_INSTRUCTION);
    expect(
      await buildAgentSystemPrompt({ ...common, mcpTools: {} }),
    ).not.toContain(TOOL_UI_RESULT_INSTRUCTION);
  });

  test("adds the tool-loading instruction only in search_and_run_only mode", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const searchAgent = await makeAgent({
      systemPrompt: "Base.",
      toolExposureMode: "search_and_run_only",
    });
    await makeMember(user.id, searchAgent.organizationId);

    const searchPrompt = await buildAgentSystemPrompt({
      agent: searchAgent,
      mcpTools: {},
      organizationId: searchAgent.organizationId,
      userId: user.id,
      agentId: searchAgent.id,
    });
    expect(searchPrompt).toContain("must be discovered");

    const fullAgent = await makeAgent({
      systemPrompt: "Base.",
      toolExposureMode: "full",
      organizationId: searchAgent.organizationId,
    });
    const fullPrompt = await buildAgentSystemPrompt({
      agent: fullAgent,
      mcpTools: {},
      organizationId: fullAgent.organizationId,
      userId: user.id,
      agentId: fullAgent.id,
    });
    expect(fullPrompt).not.toContain("must be discovered");
  });

  test("appends the hook session context last", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({
      systemPrompt: "Base.",
      toolExposureMode: "full",
    });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);

    const prompt = await buildAgentSystemPrompt({
      agent,
      mcpTools: {},
      organizationId: agent.organizationId,
      userId: user.id,
      agentId: agent.id,
      hookSessionContext: "SESSION-CONTEXT-MARKER",
    });

    expect(prompt?.endsWith("SESSION-CONTEXT-MARKER")).toBe(true);
  });

  test("injects project instructions right after the agent's own prompt", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({
      systemPrompt: "You are helpful.",
      toolExposureMode: "full",
    });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);

    const prompt = await buildAgentSystemPrompt({
      agent,
      mcpTools: {},
      organizationId: agent.organizationId,
      userId: user.id,
      agentId: agent.id,
      projectInstructions: "PROJECT-RULES-MARKER",
    });

    // Present, framed by the canonical prefix, and positioned after the agent
    // prompt but before the denial instruction.
    expect(prompt).toContain(PROJECT_INSTRUCTIONS_PREFIX);
    expect(prompt).toContain("PROJECT-RULES-MARKER");
    expect(prompt).toBe(
      `You are helpful.\n\n${PROJECT_INSTRUCTIONS_PREFIX}\n\nPROJECT-RULES-MARKER\n\n${TOOL_DENIAL_INSTRUCTION}`,
    );
  });

  test("omits the project instructions section when none are given", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({
      systemPrompt: "You are helpful.",
      toolExposureMode: "full",
    });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);

    const prompt = await buildAgentSystemPrompt({
      agent,
      mcpTools: {},
      organizationId: agent.organizationId,
      userId: user.id,
      agentId: agent.id,
    });

    expect(prompt).not.toContain(PROJECT_INSTRUCTIONS_PREFIX);
  });

  test("returns the denial instruction alone for an agent with no base prompt or tools", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({
      systemPrompt: null,
      toolExposureMode: "full",
    });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);

    const prompt = await buildAgentSystemPrompt({
      agent,
      mcpTools: {},
      organizationId: agent.organizationId,
      userId: user.id,
      agentId: agent.id,
    });

    expect(prompt).toBe(TOOL_DENIAL_INSTRUCTION);
  });
});

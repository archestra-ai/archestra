import {
  ADMIN_ROLE_NAME,
  type ArchestraToolShortName,
  TOOL_DOWNLOAD_FILE_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_READ_FILE_SHORT_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
  TOOL_SAVE_FILE_SHORT_NAME,
  TOOL_SCAFFOLD_APP_SHORT_NAME,
  TOOL_SEARCH_FILES_SHORT_NAME,
  TOOL_UPLOAD_FILE_SHORT_NAME,
} from "@archestra/shared";
import type { Tool } from "ai";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { SkillModel } from "@/models";
import { SKILL_SANDBOX_ATTACHMENTS_DIR } from "@/skills-sandbox/runtime-image";
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

const brand = (shortName: ArchestraToolShortName) =>
  archestraMcpBranding.getToolName(shortName);
const searchFilesToolName = brand(TOOL_SEARCH_FILES_SHORT_NAME);
// Sandbox runtime + persistent-file tools: the "full" file surface.
const withFileTools: Record<string, Tool> = {
  [brand(TOOL_RUN_COMMAND_SHORT_NAME)]: {} as Tool,
  [brand(TOOL_DOWNLOAD_FILE_SHORT_NAME)]: {} as Tool,
  [brand(TOOL_UPLOAD_FILE_SHORT_NAME)]: {} as Tool,
  [searchFilesToolName]: {} as Tool,
  [brand(TOOL_READ_FILE_SHORT_NAME)]: {} as Tool,
  [brand(TOOL_SAVE_FILE_SHORT_NAME)]: {} as Tool,
};
// Sandbox runtime only (Projects off): no persistent-file tools.
const withSandboxOnly: Record<string, Tool> = {
  [brand(TOOL_RUN_COMMAND_SHORT_NAME)]: {} as Tool,
  [brand(TOOL_DOWNLOAD_FILE_SHORT_NAME)]: {} as Tool,
  [brand(TOOL_UPLOAD_FILE_SHORT_NAME)]: {} as Tool,
};

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

  test("adds file-handling guidance only when the agent has file tools", async ({
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

    const withFiles = await buildAgentSystemPrompt({
      ...common,
      mcpTools: withFileTools,
    });
    // sandbox surface
    expect(withFiles).toContain("code execution environment");
    expect(withFiles).toContain(SKILL_SANDBOX_ATTACHMENTS_DIR);
    // persistent-files surface + the "find the file the user referred to" path
    expect(withFiles).toContain("persistent files");
    expect(withFiles).toContain("Files panel");
    expect(withFiles).toContain(searchFilesToolName);
    expect(withFiles).toContain("did not attach this turn");

    // an agent with no file tools gets no file-handling guidance at all
    const withoutFiles = await buildAgentSystemPrompt({
      ...common,
      mcpTools: someTool,
    });
    expect(withoutFiles).not.toContain("code execution environment");
    expect(withoutFiles).not.toContain(SKILL_SANDBOX_ATTACHMENTS_DIR);
    expect(withoutFiles).not.toContain("persistent files");
  });

  test("words file guidance to the tools present: sandbox-only omits persistent-file discovery", async ({
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
      mcpTools: withSandboxOnly,
      organizationId: agent.organizationId,
      userId: user.id,
      agentId: agent.id,
    });

    // sandbox guidance is present, but the persistent-file search/discovery
    // paragraph is not — those tools aren't available to this agent.
    expect(prompt).toContain("code execution environment");
    expect(prompt).not.toContain(searchFilesToolName);
    expect(prompt).not.toContain("did not attach this turn");
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

  // The app tools are hidden from tools/list in search_and_run_only mode, so
  // the tool-loading section names scaffold_app verbatim (run_tool only
  // accepts names the model has seen) — unconditionally, with no dispatch-gate
  // mirroring: a non-dispatchable name is refused by run_tool with a clear
  // error at call time.
  test("names scaffold_app in the tool-loading instruction regardless of assignment", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const scaffoldAppName = brand(TOOL_SCAFFOLD_APP_SHORT_NAME);

    const searchAgent = await makeAgent({
      systemPrompt: "Base.",
      toolExposureMode: "search_and_run_only",
    });
    await makeMember(user.id, searchAgent.organizationId);
    const common = {
      mcpTools: {},
      organizationId: searchAgent.organizationId,
      userId: user.id,
    };

    // nothing assigned — the steering still names the build entry point
    const searchPrompt = await buildAgentSystemPrompt({
      ...common,
      agent: searchAgent,
      agentId: searchAgent.id,
    });
    expect(searchPrompt).toContain(scaffoldAppName);

    // full mode has no tool-loading section, so no app steering either
    const fullAgent = await makeAgent({
      systemPrompt: "Base.",
      toolExposureMode: "full",
      organizationId: searchAgent.organizationId,
    });
    const fullPrompt = await buildAgentSystemPrompt({
      ...common,
      agent: fullAgent,
      agentId: fullAgent.id,
    });
    expect(fullPrompt).not.toContain(scaffoldAppName);
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

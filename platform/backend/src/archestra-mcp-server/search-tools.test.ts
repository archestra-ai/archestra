// biome-ignore-all lint/suspicious/noExplicitAny: test assertions inspect tool payloads dynamically
import {
  TOOL_ACTIVATE_SKILL_FULL_NAME,
  TOOL_CREATE_SKILL_FULL_NAME,
  TOOL_DOWNLOAD_FILE_FULL_NAME,
  TOOL_LIST_SKILLS_FULL_NAME,
  TOOL_READ_SKILL_FILE_FULL_NAME,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
  TOOL_UPDATE_SKILL_FULL_NAME,
  TOOL_UPLOAD_FILE_FULL_NAME,
} from "@archestra/shared";
import { describe, expect, test } from "@/test";
import type { ArchestraContext } from ".";
import { executeArchestraTool } from ".";

type SearchToolsStructuredContent = {
  total: number;
  tools: Array<{
    toolName: string;
    catalogName: string | null;
  }>;
};

describe("search_tools", () => {
  test("returns ranked matching tools with compact parameter summaries", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTool,
    makeAgentTool,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      name: "Search Agent",
      organizationId: org.id,
    });
    await seedAndAssignArchestraTools(agent.id);

    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "GitHub MCP",
    });
    const githubTool = await makeTool({
      name: "github__search_repositories",
      description: "Search repositories by topic, language, or owner.",
      catalogId: catalog.id,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Repository search query string.",
          },
          language: {
            type: "string",
            description: "Optional language filter.",
          },
        },
        required: ["query"],
      },
    });
    await makeAgentTool(agent.id, githubTool.id);

    const context: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
    };

    const result = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "repository search", limit: 5 },
      context,
    );

    expect(result.isError).toBe(false);
    const structuredContent =
      result.structuredContent as SearchToolsStructuredContent;
    const firstResult = structuredContent.tools[0];
    expect(structuredContent.total).toBeGreaterThan(0);
    expect(firstResult).toEqual({
      toolName: "github__search_repositories",
      title: null,
      description: "Search repositories by topic, language, or owner.",
      source: "mcp",
      server: "github",
      catalogName: "GitHub MCP",
      inputParameters: [
        {
          name: "query",
          required: true,
          description: "Repository search query string.",
        },
        {
          name: "language",
          required: false,
          description: "Optional language filter.",
        },
      ],
    });

    const genericQueryResult = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "tool", limit: 20 },
      context,
    );

    expect(genericQueryResult.isError).toBe(false);
    const genericStructuredContent =
      genericQueryResult.structuredContent as SearchToolsStructuredContent;
    const returnedToolNames = genericStructuredContent.tools.map(
      (tool) => tool.toolName,
    );
    expect(returnedToolNames).not.toContain(TOOL_SEARCH_TOOLS_FULL_NAME);
    expect(returnedToolNames).not.toContain(TOOL_RUN_TOOL_FULL_NAME);
  });

  test("filters Archestra tools by RBAC before ranking", async ({
    makeAgent,
    makeCustomRole,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { agent: ["read"] },
    });
    await makeMember(user.id, org.id, { role: role.role });

    const agent = await makeAgent({
      name: "Restricted Agent",
      organizationId: org.id,
    });
    await seedAndAssignArchestraTools(agent.id);

    const context: ArchestraContext = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: org.id,
      userId: user.id,
    };

    // "trusted data policy" matches only policy tools (trusted-data /
    // tool-invocation / autonomy), all of which require permissions this
    // agent:read role lacks, so RBAC filters them all out before ranking.
    const result = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "trusted data policy", limit: 10 },
      context,
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      total: 0,
      tools: [],
    });
  });

  test("excludes always-exposed tools but keeps authoring tools searchable", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const config = (await import("@/config")).default;
    const originalSandboxEnabled = config.skillsSandbox.enabled;
    (config.skillsSandbox as { enabled: boolean }).enabled = true;

    try {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const agent = await makeAgent({
        name: "Skill Search Agent",
        organizationId: org.id,
      });
      await seedAndAssignArchestraTools(agent.id);

      const context: ArchestraContext = {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: user.id,
      };

      const result = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "skill", limit: 20 },
        context,
      );

      expect(result.isError).toBe(false);
      const structuredContent =
        result.structuredContent as SearchToolsStructuredContent;
      const returnedToolNames = structuredContent.tools.map(
        (tool) => tool.toolName,
      );

      // the runtime path is always top-level, so never searchable
      expect(returnedToolNames).not.toContain(TOOL_LIST_SKILLS_FULL_NAME);
      expect(returnedToolNames).not.toContain(TOOL_ACTIVATE_SKILL_FULL_NAME);
      expect(returnedToolNames).not.toContain(TOOL_READ_SKILL_FILE_FULL_NAME);
      expect(returnedToolNames).not.toContain(TOOL_RUN_COMMAND_FULL_NAME);
      expect(returnedToolNames).not.toContain(TOOL_DOWNLOAD_FILE_FULL_NAME);
      expect(returnedToolNames).not.toContain(TOOL_UPLOAD_FILE_FULL_NAME);
      // authoring tools stay search-gated, so they remain discoverable
      expect(returnedToolNames).toContain(TOOL_CREATE_SKILL_FULL_NAME);
      expect(returnedToolNames).toContain(TOOL_UPDATE_SKILL_FULL_NAME);

      const runtimeResult = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "download upload command sandbox file", limit: 20 },
        context,
      );

      expect(runtimeResult.isError).toBe(false);
      const runtimeStructuredContent =
        runtimeResult.structuredContent as SearchToolsStructuredContent;
      const runtimeReturnedToolNames = runtimeStructuredContent.tools.map(
        (tool) => tool.toolName,
      );
      expect(runtimeReturnedToolNames).not.toContain(
        TOOL_RUN_COMMAND_FULL_NAME,
      );
      expect(runtimeReturnedToolNames).not.toContain(
        TOOL_DOWNLOAD_FILE_FULL_NAME,
      );
      expect(runtimeReturnedToolNames).not.toContain(
        TOOL_UPLOAD_FILE_FULL_NAME,
      );
    } finally {
      (config.skillsSandbox as { enabled: boolean }).enabled =
        originalSandboxEnabled;
    }
  });

  test("returns an error without agent context", async () => {
    const result = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "repository search" },
      {
        agent: { id: "agent-id", name: "Agent" },
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "search_tools requires agent context",
    );
  });
});

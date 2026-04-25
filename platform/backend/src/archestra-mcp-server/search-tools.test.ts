// biome-ignore-all lint/suspicious/noExplicitAny: test assertions inspect tool payloads dynamically
import { TOOL_RUN_TOOL_FULL_NAME, TOOL_SEARCH_TOOLS_FULL_NAME } from "@shared";
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

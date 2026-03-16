// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { AgentKnowledgeBaseModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { tools } from "./agents";

describe("agent tools", () => {
  test("should have create_agent tool", () => {
    const tool = tools.find((t) => t.name.endsWith("create_agent"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Create Agent");
  });

  test("should have create_llm_proxy tool", () => {
    const tool = tools.find((t) => t.name.endsWith("create_llm_proxy"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Create LLM Proxy");
  });

  test("should have create_mcp_gateway tool", () => {
    const tool = tools.find((t) => t.name.endsWith("create_mcp_gateway"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Create MCP Gateway");
  });

  test("should have get_agent tool", () => {
    const tool = tools.find((t) => t.name.endsWith("get_agent"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Get Agent");
  });

  test("should have list_agents tool", () => {
    const tool = tools.find((t) => t.name.endsWith("list_agents"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("List Agents");
  });

  test("should have edit_agent tool", () => {
    const tool = tools.find((t) => t.name.endsWith("edit_agent"));
    expect(tool).toBeDefined();
    expect(tool?.title).toBe("Edit Agent");
  });
});

describe("agent tool execution", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({ name: "Test Agent", organizationId: org.id });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: org.id,
    };
  });

  test("create_agent requires name", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
      { name: "" },
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("name is required");
  });

  test("create_agent creates an agent successfully", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
      { name: "New Test Agent" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully created agent",
    );
    expect((result.content[0] as any).text).toContain("New Test Agent");
  });

  test("create_llm_proxy creates a proxy successfully", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_llm_proxy`,
      { name: "Test LLM Proxy" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully created llm proxy",
    );
  });

  test("create_mcp_gateway creates a gateway successfully", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_gateway`,
      { name: "Test MCP Gateway" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully created mcp gateway",
    );
  });

  test("get_agent requires id or name", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_agent`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "either id or name parameter is required",
    );
  });

  test("list_agents returns results", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}list_agents`,
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed).toHaveProperty("total");
    expect(parsed).toHaveProperty("agents");
  });

  test("list_agents includes tools and knowledge sources", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    makeKnowledgeBase,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Agent With Resources",
      organizationId: org.id,
      agentType: "agent",
    });

    // Assign a tool to the agent
    const tool = await makeTool({
      name: "test-search-tool",
      description: "Searches documents",
    });
    await makeAgentTool(agent.id, tool.id);

    // Create and assign a knowledge base
    const kb = await makeKnowledgeBase(org.id, {
      name: "Product Docs",
    });
    await AgentKnowledgeBaseModel.assign(agent.id, kb.id);

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}list_agents`,
      { name: "Agent With Resources" },
      {
        ...mockContext,
        agent: { id: agent.id, name: agent.name },
      },
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.agents.length).toBeGreaterThanOrEqual(1);

    const found = parsed.agents.find((a: any) => a.id === agent.id);
    expect(found).toBeDefined();

    // Verify tools
    expect(found.tools).toEqual([
      { name: "test-search-tool", description: "Searches documents" },
    ]);

    // Verify knowledge sources
    expect(found.knowledgeSources).toEqual([
      { name: "Product Docs", description: null, type: "knowledge_base" },
    ]);
  });
});

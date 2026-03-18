// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { AgentKnowledgeBaseModel, AgentModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

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

  test("create_agent assigns knowledge bases and connectors", async ({
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) {
      throw new Error("Expected organizationId in test context");
    }

    const kb = await makeKnowledgeBase(organizationId);
    const connector = await makeKnowledgeBaseConnector(kb.id, organizationId);

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
      {
        name: "Agent With Knowledge",
        knowledgeBaseIds: [kb.id],
        connectorIds: [connector.id],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);

    const createdAgentId = extractCreatedId(result);
    const created = await AgentModel.findById(
      createdAgentId,
      mockContext.userId,
      true,
    );

    expect(created).toBeTruthy();
    expect(created?.knowledgeBaseIds).toEqual([kb.id]);
    expect(created?.connectorIds).toEqual([connector.id]);
  });

  test("create_agent does not write invalid remote MCP tool assignments from mcpServerIds", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    await makeTool({
      name: "remote_catalog_tool",
      catalogId: catalog.id,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
      {
        name: "Agent With Invalid Catalog Assignment",
        mcpServerIds: [catalog.id],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain("validation_failed");

    const createdAgentId = ((result.content[0] as any).text as string)
      .split("\n")
      .find((line) => line.startsWith("ID: "))
      ?.replace("ID: ", "");
    expect(createdAgentId).toBeDefined();
    if (!createdAgentId) {
      throw new Error("Expected created agent id in tool output");
    }

    const createdAssignments = await db
      .select()
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, createdAgentId));
    expect(createdAssignments).toEqual([]);
  });

  test("create_agent supports validated toolAssignments with dynamic credentials", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      name: "remote_dynamic_assignment_tool",
      catalogId: catalog.id,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
      {
        name: "Agent With Dynamic Tool Assignment",
        toolAssignments: [
          {
            toolId: tool.id,
            useDynamicTeamCredential: true,
          },
        ],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain("Tool Assignments:");
    expect((result.content[0] as any).text).toContain(`${tool.id}: success`);

    const createdAgentId = ((result.content[0] as any).text as string)
      .split("\n")
      .find((line) => line.startsWith("ID: "))
      ?.replace("ID: ", "");
    expect(createdAgentId).toBeDefined();
    if (!createdAgentId) {
      throw new Error("Expected created agent id in tool output");
    }

    const [assignment] = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, createdAgentId),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );
    expect(assignment).toBeDefined();
    expect(assignment.useDynamicTeamCredential).toBe(true);
  });

  test("edit_agent replaces assigned knowledge bases and connectors", async ({
    makeAgent,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) {
      throw new Error("Expected organizationId in test context");
    }

    const existingKb = await makeKnowledgeBase(organizationId);
    const existingConnector = await makeKnowledgeBaseConnector(
      existingKb.id,
      organizationId,
    );
    const agent = await makeAgent({
      name: "Knowledge Agent",
      agentType: "agent",
      organizationId,
      knowledgeBaseIds: [existingKb.id],
      connectorIds: [existingConnector.id],
    });

    const replacementKb = await makeKnowledgeBase(organizationId);
    const replacementConnector = await makeKnowledgeBaseConnector(
      replacementKb.id,
      organizationId,
    );

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_agent`,
      {
        id: agent.id,
        knowledgeBaseIds: [replacementKb.id],
        connectorIds: [replacementConnector.id],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully updated agent",
    );

    const updated = await AgentModel.findById(
      agent.id,
      mockContext.userId,
      true,
    );
    expect(updated?.knowledgeBaseIds).toEqual([replacementKb.id]);
    expect(updated?.connectorIds).toEqual([replacementConnector.id]);
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
    makeKnowledgeBaseConnector,
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
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      name: "Jira Connector",
    });
    await AgentModel.update(agent.id, {
      connectorIds: [connector.id],
    });

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
    expect(found.knowledgeSources).toContainEqual({
      name: "Product Docs",
      description: null,
      type: "knowledge_base",
    });
    expect(found.knowledgeSources).toContainEqual({
      name: "Jira Connector",
      description: null,
      type: "knowledge_connector",
    });
  });
});

describe("agent RBAC visibility", () => {
  test("list_agents only returns agents accessible to non-admin member", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });

    const teamA = await makeTeam(org.id, user.id, { name: "Team A" });
    const teamB = await makeTeam(org.id, user.id, { name: "Team B" });
    await makeTeamMember(teamA.id, user.id);
    // user is NOT a member of teamB

    const visibleAgent = await makeAgent({
      name: "Visible Agent",
      agentType: "agent",
      organizationId: org.id,
      scope: "team",
      teams: [teamA.id],
    });
    await makeAgent({
      name: "Hidden Agent",
      agentType: "agent",
      organizationId: org.id,
      scope: "team",
      teams: [teamB.id],
    });

    const memberContext: ArchestraContext = {
      agent: { id: visibleAgent.id, name: visibleAgent.name },
      userId: user.id,
      organizationId: org.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}list_agents`,
      {},
      memberContext,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    const agentNames = parsed.agents.map((a: any) => a.name);
    expect(agentNames).toContain("Visible Agent");
    expect(agentNames).not.toContain("Hidden Agent");
  });

  test("get_agent by name does not return inaccessible team-scoped agent", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeTeam,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });

    const teamB = await makeTeam(org.id, user.id, { name: "Team B" });
    // user is NOT a member of teamB

    const inaccessibleAgent = await makeAgent({
      name: "Secret Agent",
      agentType: "agent",
      organizationId: org.id,
      scope: "team",
      teams: [teamB.id],
    });

    const memberContext: ArchestraContext = {
      agent: { id: inaccessibleAgent.id, name: inaccessibleAgent.name },
      userId: user.id,
      organizationId: org.id,
    };

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_agent`,
      { name: "Secret Agent" },
      memberContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("not found");
  });
});

function extractCreatedId(
  result: Awaited<ReturnType<typeof executeArchestraTool>>,
) {
  const createdAgentId = ((result.content[0] as any).text as string)
    .split("\n")
    .find((line) => line.startsWith("ID: "))
    ?.replace("ID: ", "");

  if (!createdAgentId) {
    throw new Error("Expected created agent id in tool output");
  }

  return createdAgentId;
}

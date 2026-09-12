// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_LIST_AGENTS_SHORT_NAME,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  AgentKnowledgeBaseModel,
  AgentModel,
  LlmProviderApiKeyModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { archestraMcpBranding } from "./branding";

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
    // The reader gets the agent's own edit page, not a list that would have to
    // resolve the id itself.
    expect((result.content[0] as any).text).toContain(
      `/agents/${extractCreatedId(result)}/edit`,
    );
  });

  test("create_agent attributes the calling user as author for org-scoped agents", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
      { name: "Org Scoped Agent", scope: "org" },
      mockContext,
    );
    expect(result.isError).toBe(false);

    const created = await AgentModel.findById(
      extractCreatedId(result),
      mockContext.userId,
      true,
    );
    expect(created?.scope).toBe("org");
    expect(created?.authorId).toBe(mockContext.userId);
  });

  test("create_agent persists toolExposureMode", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
      {
        name: "Search And Run Agent",
        toolExposureMode: "search_and_run_only",
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

    expect(created?.toolExposureMode).toBe("search_and_run_only");
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

  test("create_agent supports validated toolAssignments with late-bound resolution", async ({
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
            resolveAtCallTime: true,
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
    expect(assignment.credentialResolutionMode).toBe("dynamic");
  });

  test("create_agent reports invalid remote toolAssignments without credentials", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      name: "remote_catalog_tool",
      catalogId: catalog.id,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
      {
        name: "Agent With Invalid Tool Assignment",
        toolAssignments: [
          {
            toolId: tool.id,
          },
        ],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain("Tool Assignments:");
    expect((result.content[0] as any).text).toContain(`${tool.id}: error`);
    expect((result.content[0] as any).text).toContain(
      "An MCP server installation or non-static credential resolution is required for remote MCP server tools",
    );
  });

  test("create_agent assigns local MCP tools with late-bound resolution via toolAssignments", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    const tool = await makeTool({
      name: "local_dynamic_catalog_tool",
      catalogId: catalog.id,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
      {
        name: "Agent With Local Dynamic Tool Assignment",
        toolAssignments: [
          {
            toolId: tool.id,
            resolveAtCallTime: true,
          },
        ],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain("Tool Assignments:");
    expect((result.content[0] as any).text).toContain(`${tool.id}: success`);

    const createdAgentId = extractCreatedId(result);
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
    expect(assignment.credentialResolutionMode).toBe("dynamic");
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

  test("edit_agent updates toolExposureMode", async ({ makeAgent }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) {
      throw new Error("Expected organizationId in test context");
    }

    const agent = await makeAgent({
      name: "Editable Tool Exposure Agent",
      agentType: "agent",
      organizationId,
      toolExposureMode: "full",
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_agent`,
      {
        id: agent.id,
        toolExposureMode: "search_and_run_only",
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
    expect(updated?.toolExposureMode).toBe("search_and_run_only");
  });

  test("edit_agent assigns MCP tools with late-bound resolution via toolAssignments", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) {
      throw new Error("Expected organizationId in test context");
    }

    const agent = await makeAgent({
      name: "Editable Dynamic Assignment Agent",
      agentType: "agent",
      organizationId,
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      name: "remote_dynamic_edit_catalog_tool",
      catalogId: catalog.id,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_agent`,
      {
        id: agent.id,
        toolAssignments: [
          {
            toolId: tool.id,
            resolveAtCallTime: true,
          },
        ],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain("Tool Assignments:");
    expect((result.content[0] as any).text).toContain(`${tool.id}: success`);

    const [assignment] = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );
    expect(assignment).toBeDefined();
    expect(assignment.credentialResolutionMode).toBe("dynamic");
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

  test("list_agents filters by provider key and returns its display name", async () => {
    if (!mockContext.organizationId)
      throw new Error("Missing organization fixture");
    const key = await LlmProviderApiKeyModel.create({
      organizationId: mockContext.organizationId,
      userId: mockContext.userId,
      name: "Operations provider",
      provider: "openai",
      scope: "org",
    });
    const selected = await AgentModel.create({
      name: "Configured assistant",
      agentType: "agent",
      organizationId: mockContext.organizationId,
      scope: "org",
      teams: [],
      llmApiKeyId: key.id,
    });
    const result = await executeArchestraTool(
      archestraMcpBranding.getToolName(TOOL_LIST_AGENTS_SHORT_NAME),
      { providerApiKeyId: key.id },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.total).toBe(1);
    expect(parsed.agents).toMatchObject([
      {
        id: selected.id,
        resolvedLlmProviderKeyName: "Operations provider",
        resolvedLlmModelName: null,
      },
    ]);
  });

  test("list_agents can select agents using the organization default", async () => {
    if (!mockContext.organizationId)
      throw new Error("Missing organization fixture");
    const inherited = await AgentModel.create({
      name: "Inherited assistant",
      agentType: "agent",
      organizationId: mockContext.organizationId,
      scope: "org",
      teams: [],
    });
    const key = await LlmProviderApiKeyModel.create({
      organizationId: mockContext.organizationId,
      userId: mockContext.userId,
      name: "Pinned key",
      provider: "openai",
      scope: "org",
    });
    const pinned = await AgentModel.create({
      name: "Pinned assistant",
      agentType: "agent",
      organizationId: mockContext.organizationId,
      scope: "org",
      teams: [],
      llmApiKeyId: key.id,
    });
    const result = await executeArchestraTool(
      archestraMcpBranding.getToolName(TOOL_LIST_AGENTS_SHORT_NAME),
      { providerApiKeyId: "organization-default" },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.agents.map((agent: { id: string }) => agent.id)).toContain(
      inherited.id,
    );
    expect(
      parsed.agents.map((agent: { id: string }) => agent.id),
    ).not.toContain(pinned.id);
  });

  test("list_agents includes tools and knowledge sources", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    if (!mockContext.organizationId)
      throw new Error("Missing organization fixture");
    const organizationId = mockContext.organizationId;
    const agent = await makeAgent({
      name: "Agent With Resources",
      organizationId,
      agentType: "agent",
    });

    // Assign a tool to the agent
    const tool = await makeTool({
      name: "test-search-tool",
      description: "Searches documents",
    });
    await makeAgentTool(agent.id, tool.id);

    // Create and assign a knowledge base
    const kb = await makeKnowledgeBase(organizationId, {
      name: "Product Docs",
    });
    await AgentKnowledgeBaseModel.assign(agent.id, kb.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, organizationId, {
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
  test.for([
    "admin",
    "member",
  ] as const)("list_agents scopes %s results and provider metadata to the context organization", async (role, {
    makeUser,
    makeOrganization,
    makeMember,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    const unrelatedOrganization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role });
    const localKey = await LlmProviderApiKeyModel.create({
      name: "Local provider",
      provider: "openai",
      scope: "org",
      organizationId: organization.id,
    });
    const unrelatedKey = await LlmProviderApiKeyModel.create({
      name: "Unrelated provider",
      provider: "openai",
      scope: "org",
      organizationId: unrelatedOrganization.id,
    });
    const localAgent = await makeAgent({
      name: "Local assistant",
      agentType: "agent",
      organizationId: organization.id,
      scope: "org",
      llmApiKeyId: localKey.id,
    });
    await makeAgent({
      name: "Unrelated assistant",
      agentType: "agent",
      organizationId: unrelatedOrganization.id,
      scope: "org",
      llmApiKeyId: unrelatedKey.id,
    });
    const context: ArchestraContext = {
      agent: { id: localAgent.id, name: localAgent.name },
      userId: user.id,
      organizationId: organization.id,
    };
    for (const args of [{}, { providerApiKeyId: localKey.id }]) {
      const result = await executeArchestraTool(
        archestraMcpBranding.getToolName(TOOL_LIST_AGENTS_SHORT_NAME),
        args,
        context,
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse((result.content[0] as any).text);
      expect(parsed.total).toBe(1);
      expect(parsed.agents).toMatchObject([
        {
          id: localAgent.id,
          resolvedLlmProviderKeyName: "Local provider",
        },
      ]);
    }
    const unrelatedResult = await executeArchestraTool(
      archestraMcpBranding.getToolName(TOOL_LIST_AGENTS_SHORT_NAME),
      { providerApiKeyId: unrelatedKey.id },
      context,
    );
    expect(unrelatedResult.isError).toBe(false);
    expect(JSON.parse((unrelatedResult.content[0] as any).text)).toMatchObject({
      total: 0,
      agents: [],
    });
  });

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
    expect((result.content[0] as any).text).toContain(
      archestraMcpBranding.getToolName(TOOL_LIST_AGENTS_SHORT_NAME),
    );
  });
});

describe("edit_agent team assignment", () => {
  const editAgent = (
    args: Record<string, unknown>,
    context: ArchestraContext,
  ) =>
    executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_agent`,
      args,
      context,
    );

  test("team-admin cannot move an agent to a team they do not belong to", async ({
    makeAgent,
    makeCustomRole,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const teamAdmin = await makeUser();
    await makeCustomRole(org.id, {
      role: "team_admin_role",
      permission: { agent: ["read", "create", "update", "team-admin"] },
    });
    await makeMember(teamAdmin.id, org.id, { role: "team_admin_role" });

    const ownTeam = await makeTeam(org.id, teamAdmin.id);
    await makeTeamMember(ownTeam.id, teamAdmin.id);
    const otherTeam = await makeTeam(org.id, teamAdmin.id);

    const agent = await makeAgent({
      name: "Team Scoped Agent",
      agentType: "agent",
      organizationId: org.id,
      scope: "team",
      teams: [ownTeam.id],
    });

    const result = await editAgent(
      { id: agent.id, teams: [otherTeam.id] },
      {
        agent: { id: agent.id, name: agent.name },
        userId: teamAdmin.id,
        organizationId: org.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "teams you are a member of",
    );

    // The assignment must be untouched, not partially applied.
    const unchanged = await AgentModel.findById(agent.id, teamAdmin.id, true);
    expect(unchanged?.teams.map((team) => team.id)).toEqual([ownTeam.id]);
  });

  test("clearing the teams of a team-scoped agent is rejected, admin included", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const team = await makeTeam(org.id, admin.id);

    const agent = await makeAgent({
      name: "Team Scoped Agent",
      agentType: "agent",
      organizationId: org.id,
      scope: "team",
      teams: [team.id],
    });

    const result = await editAgent(
      { id: agent.id, teams: [] },
      {
        agent: { id: agent.id, name: agent.name },
        userId: admin.id,
        organizationId: org.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("at least one team");

    const unchanged = await AgentModel.findById(agent.id, admin.id, true);
    expect(unchanged?.teams.map((team) => team.id)).toEqual([team.id]);
  });

  test("a team from another organization is rejected", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const team = await makeTeam(org.id, admin.id);

    const otherOrg = await makeOrganization();
    const outsider = await makeUser();
    const foreignTeam = await makeTeam(otherOrg.id, outsider.id);

    const agent = await makeAgent({
      name: "Team Scoped Agent",
      agentType: "agent",
      organizationId: org.id,
      scope: "team",
      teams: [team.id],
    });

    const result = await editAgent(
      { id: agent.id, teams: [foreignTeam.id] },
      {
        agent: { id: agent.id, name: agent.name },
        userId: admin.id,
        organizationId: org.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Unknown team id");

    const unchanged = await AgentModel.findById(agent.id, admin.id, true);
    expect(unchanged?.teams.map((team) => team.id)).toEqual([team.id]);
  });

  /**
   * A static assignment pins one installed connection, and the runtime follows
   * that pin. Editing the record's teams through the MCP tool must therefore
   * refuse the same changes `PUT /api/agents/:id` refuses — the tools write
   * through the same model, so an unguarded edit here would be a way around
   * the REST guard.
   */
  test("dropping the team whose connection a static pin points at is refused", async ({
    makeAgent,
    makeAgentTool,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTool,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const teamA = await makeTeam(org.id, admin.id);
    const teamB = await makeTeam(org.id, admin.id);
    const connection = await makeMcpServer({
      name: "Team A Connection",
      scope: "team",
      teamId: teamA.id,
    });
    const tool = await makeTool({
      name: "team-a-tool",
      catalogId: connection.catalogId,
    });
    const agent = await makeAgent({
      name: "Pinned Agent",
      agentType: "agent",
      organizationId: org.id,
      scope: "team",
      teams: [teamA.id],
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });

    const result = await editAgent(
      { id: agent.id, teams: [teamB.id] },
      {
        agent: { id: agent.id, name: agent.name },
        userId: admin.id,
        organizationId: org.id,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("team-a-tool");
    expect((result.content[0] as any).text).toContain("Team A Connection");

    // Nothing was written.
    const unchanged = await AgentModel.findById(agent.id, admin.id, true);
    expect(unchanged?.teams.map((team) => team.id)).toEqual([teamA.id]);
  });

  test("a team change that keeps the pinned connection's team goes through", async ({
    makeAgent,
    makeAgentTool,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTool,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const teamA = await makeTeam(org.id, admin.id);
    const teamB = await makeTeam(org.id, admin.id);
    const connection = await makeMcpServer({
      scope: "team",
      teamId: teamA.id,
    });
    const tool = await makeTool({ catalogId: connection.catalogId });
    const agent = await makeAgent({
      name: "Pinned Agent",
      agentType: "agent",
      organizationId: org.id,
      scope: "team",
      teams: [teamA.id],
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });

    const result = await editAgent(
      { id: agent.id, teams: [teamA.id, teamB.id] },
      {
        agent: { id: agent.id, name: agent.name },
        userId: admin.id,
        organizationId: org.id,
      },
    );

    expect(result.isError).toBe(false);
    const updated = await AgentModel.findById(agent.id, admin.id, true);
    expect(updated?.teams.map((team) => team.id).sort()).toEqual(
      [teamA.id, teamB.id].sort(),
    );
  });

  test("an edit that leaves scope and teams alone still succeeds", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const team = await makeTeam(org.id, admin.id);

    const agent = await makeAgent({
      name: "Team Scoped Agent",
      agentType: "agent",
      organizationId: org.id,
      scope: "team",
      teams: [team.id],
    });

    const result = await editAgent(
      { id: agent.id, description: "Updated description" },
      {
        agent: { id: agent.id, name: agent.name },
        userId: admin.id,
        organizationId: org.id,
      },
    );

    expect(result.isError).toBe(false);
    const updated = await AgentModel.findById(agent.id, admin.id, true);
    expect(updated?.description).toBe("Updated description");
    expect(updated?.teams.map((t) => t.id)).toEqual([team.id]);
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

// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_CATALOG_ID,
  ARCHESTRA_MCP_SERVER_NAME,
  type ArchestraToolShortName,
  buildAgentCatalogRuntime,
  buildCustomAgentRuntime,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_CREATE_AGENT_SHORT_NAME,
  TOOL_EDIT_AGENT_SHORT_NAME,
  TOOL_GET_AGENT_SHORT_NAME,
  TOOL_LIST_AGENTS_SHORT_NAME,
  TOOL_LIST_LLM_MODELS_SHORT_NAME,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import {
  AgentKnowledgeBaseModel,
  AgentModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
  ToolModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
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

  test("create_agent defaults Manual agents to progressive loading", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
      { name: "Manual Progressive Agent", accessAllTools: false },
      mockContext,
    );
    expect(result.isError).toBe(false);
    const created = await AgentModel.findById(
      extractCreatedId(result),
      mockContext.userId,
      true,
    );
    expect(created?.accessAllTools).toBe(false);
    expect(created?.toolExposureMode).toBe("search_and_run_only");
  });

  test("create_agent attributes the calling user as author", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
      { name: "Attributed Agent" },
      mockContext,
    );
    expect(result.isError).toBe(false);

    const created = await AgentModel.findById(
      extractCreatedId(result),
      mockContext.userId,
      true,
    );
    expect(created?.authorId).toBe(mockContext.userId);
  });

  test("create_agent refuses the retired scope and teams arguments", async () => {
    // Who can reach a new agent is its initialGrants alone.
    for (const sharing of [
      { scope: "org" },
      { teams: [crypto.randomUUID()] },
    ]) {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_agent`,
        { name: "Retired Sharing Agent", ...sharing },
        mockContext,
      );
      expect(result.isError).toBe(true);
    }
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

  test("get_agent does not cross the active organization boundary", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const otherOrganization = await makeOrganization();
    const foreignAgent = await makeAgent({
      name: `Foreign ${crypto.randomUUID()}`,
      agentType: "agent",
      organizationId: otherOrganization.id,
    });

    for (const lookup of [
      { id: foreignAgent.id },
      { name: foreignAgent.name },
    ]) {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_agent`,
        lookup,
        mockContext,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toMatch(/agent not found/i);
    }
  });

  test("get_agent exposes the skills the caller can activate through it", async ({
    makeAgent,
    makeSkill,
  }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) throw new Error("Expected organization context");
    await OrganizationModel.patch(organizationId, { skillToolsEnabled: true });
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const agent = await makeAgent({
      name: "Skilled Agent",
      agentType: "agent",
      organizationId,
    });
    await ToolModel.assignSkillToolsToAgent(agent.id, organizationId);
    const skill = await makeSkill(organizationId, {
      name: "triage-incidents",
      description: "Triage incoming incidents",
      content: "# Instructions",
      access: "org",
    });
    if (!skill) throw new Error("Expected skill to be created");

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_agent`,
      { id: agent.id },
      mockContext,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.skillsEnabled).toBe(true);
    expect(parsed.skillsNotice).toMatch(/never follow directions/i);
    expect(parsed.skills).toEqual([
      {
        reference: { source: "native", skillId: skill.id },
        name: "triage-incidents",
        activationName: "triage-incidents",
        description: "Triage incoming incidents",
        // Derived from the skill's grants, not the retired column.
        scope: "org",
        providerName: null,
      },
    ]);
  });

  test("get_agent omits activation skills when the caller cannot read skills", async ({
    makeAgent,
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) throw new Error("Expected organization context");
    const restrictedUser = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read"] },
    });
    await makeMember(restrictedUser.id, organizationId, { role: role.role });
    const sharedAgent = await makeAgent({
      name: "Shared Agent",
      agentType: "agent",
      organizationId,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}get_agent`,
      { id: sharedAgent.id },
      { ...mockContext, userId: restrictedUser.id },
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed).not.toHaveProperty("skillsEnabled");
    expect(parsed).not.toHaveProperty("skillsNotice");
    expect(parsed).not.toHaveProperty("skills");
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

  test("list_agents identifies agents that can retain and steer runtime work", async ({
    makeAgent,
  }) => {
    const foregroundAgent = await makeAgent({
      organizationId: testAgent.organizationId,
      agentType: "agent",
    });
    const runtimeAgent = await makeAgent({
      organizationId: testAgent.organizationId,
      agentType: "agent",
      runtime: {
        image: "example.test/agent:current",
        command: null,
        inferenceProtocol: "anthropic",
        backend: "kubernetes",
        steerMode: "pipe",
        privileged: false,
        resources: null,
        environment: null,
        credentials: null,
        ttlHours: null,
        maxCostUsd: null,
        idleTimeoutMinutes: null,
      },
    });
    for (const enabled of [true, false]) {
      config.agentRuntime.enabled = enabled;
      const result = await executeArchestraTool(
        archestraMcpBranding.getToolName(TOOL_LIST_AGENTS_SHORT_NAME),
        {},
        mockContext,
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: runtimeAgent.id,
            executionMode: enabled ? "runtime" : "foreground",
          }),
          expect.objectContaining({
            id: foregroundAgent.id,
            executionMode: "foreground",
          }),
        ]),
      );
    }
  });

  test("list_agents filters by provider key and returns its display name", async ({
    makeAgent,
    makeLlmProviderApiKey,
  }) => {
    if (!mockContext.organizationId)
      throw new Error("Missing organization fixture");
    const key = await makeLlmProviderApiKey(mockContext.organizationId, null, {
      userId: mockContext.userId,
      name: "Operations provider",
      provider: "openai",
      access: "org",
    });
    const selected = await makeAgent({
      name: "Configured assistant",
      agentType: "agent",
      organizationId: mockContext.organizationId,
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

  test("list_agents can select agents using the organization default", async ({
    makeAgent,
    makeLlmProviderApiKey,
  }) => {
    if (!mockContext.organizationId)
      throw new Error("Missing organization fixture");
    const inherited = await makeAgent({
      name: "Inherited assistant",
      agentType: "agent",
      organizationId: mockContext.organizationId,
    });
    const key = await makeLlmProviderApiKey(mockContext.organizationId, null, {
      userId: mockContext.userId,
      name: "Pinned key",
      provider: "openai",
      access: "org",
    });
    const pinned = await makeAgent({
      name: "Pinned assistant",
      agentType: "agent",
      organizationId: mockContext.organizationId,
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
    makeLlmProviderApiKey,
  }) => {
    const organization = await makeOrganization();
    const unrelatedOrganization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role });
    const localKey = await makeLlmProviderApiKey(organization.id, null, {
      name: "Local provider",
      provider: "openai",
    });
    const unrelatedKey = await makeLlmProviderApiKey(
      unrelatedOrganization.id,
      null,
      {
        name: "Unrelated provider",
        provider: "openai",
      },
    );
    const localAgent = await makeAgent({
      name: "Local assistant",
      agentType: "agent",
      organizationId: organization.id,
      llmApiKeyId: localKey.id,
    });
    await makeAgent({
      name: "Unrelated assistant",
      agentType: "agent",
      organizationId: unrelatedOrganization.id,
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
      access: { teams: [teamA.id] },
    });
    await makeAgent({
      name: "Hidden Agent",
      agentType: "agent",
      organizationId: org.id,
      access: { teams: [teamB.id] },
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

  test("list_agents narrows an admin's results by access", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const otherUser = await makeUser();
    await makeMember(otherUser.id, org.id, { role: "member" });

    const mine = await makeAgent({
      name: "Access Mine",
      agentType: "agent",
      organizationId: org.id,
      access: "personal",
      authorId: admin.id,
    });
    await makeAgent({
      name: "Access Other Personal",
      agentType: "agent",
      organizationId: org.id,
      access: "personal",
      authorId: otherUser.id,
    });
    await makeAgent({
      name: "Access Org",
      agentType: "agent",
      organizationId: org.id,
      access: "org",
      authorId: otherUser.id,
    });

    const context: ArchestraContext = {
      agent: { id: mine.id, name: mine.name },
      userId: admin.id,
      organizationId: org.id,
    };
    const listNames = async (access?: string[]) => {
      const result = await executeArchestraTool(
        archestraMcpBranding.getToolName(TOOL_LIST_AGENTS_SHORT_NAME),
        { name: "Access", ...(access ? { access } : {}) },
        context,
      );
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      return JSON.parse((result.content[0] as any).text)
        .agents.map((agent: { name: string }) => agent.name)
        .sort();
    };

    // Omitted keeps today's behaviour: the admin's wildcard grant reaches
    // every agent.
    expect(await listNames()).toEqual([
      "Access Mine",
      "Access Org",
      "Access Other Personal",
    ]);
    expect(await listNames(["mine"])).toEqual(["Access Mine"]);
    expect(await listNames(["others"])).toEqual(["Access Other Personal"]);
    expect(await listNames(["mine", "org"])).toEqual([
      "Access Mine",
      "Access Org",
    ]);
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
      access: { teams: [teamB.id] },
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

describe("edit_agent migrated sharing", () => {
  test("ignores retired sharing fields and permits a content-only edit", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      access: { teams: [team.id] },
      // Stored as it was before permission policies, so the check below
      // proves an edit leaves the retired columns alone.
      legacy: { scope: "team", teams: [team.id] },
    });
    const context = {
      organizationId: org.id,
      userId: user.id,
      agent: { id: agent.id, name: agent.name },
    };
    // The tool no longer accepts scope/teams at all, so a caller still sending
    // them is refused by the strict input schema and nothing is written.
    for (const sharing of [
      { teams: [] },
      { scope: "org" },
      { teams: [crypto.randomUUID()] },
    ]) {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_agent`,
        { id: agent.id, ...sharing },
        context,
      );
      expect(result.isError).toBe(true);
      const unchanged = await AgentModel.findById(agent.id);
      expect(unchanged?.scope).toBe("team");
      expect(unchanged?.teams.map((entry) => entry.id)).toEqual([team.id]);
    }
    const edited = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_agent`,
      { id: agent.id, description: "Updated description" },
      context,
    );
    expect(edited.isError).toBe(false);
    expect((await AgentModel.findById(agent.id))?.description).toBe(
      "Updated description",
    );
    // A content-only edit leaves the stored visibility exactly where it was.
    const after = await AgentModel.findById(agent.id);
    expect(after?.scope).toBe("team");
    expect(after?.teams.map((entry) => entry.id)).toEqual([team.id]);
  });
});

describe("agent runtime and model tools", () => {
  let mockContext: ArchestraContext;
  let organizationId: string;
  let previousRuntimeEnabled: boolean;
  let previousAllowPrivileged: boolean;
  let secretId: () => Promise<string>;

  beforeEach(
    async ({
      makeAgent,
      makeUser,
      makeOrganization,
      makeMember,
      makeSecret,
    }) => {
      secretId = async () =>
        (await makeSecret({ secret: { apiKey: "test-key" } })).id;
      const org = await makeOrganization();
      organizationId = org.id;
      const user = await makeUser();
      await makeMember(user.id, org.id, { role: "admin" });
      const caller = await makeAgent({ organizationId: org.id });
      mockContext = {
        agent: { id: caller.id, name: caller.name },
        userId: user.id,
        organizationId: org.id,
      };
      previousRuntimeEnabled = config.agentRuntime.enabled;
      previousAllowPrivileged = config.agentRuntime.allowPrivileged;
      config.agentRuntime.enabled = true;
    },
  );

  afterEach(() => {
    config.agentRuntime.enabled = previousRuntimeEnabled;
    config.agentRuntime.allowPrivileged = previousAllowPrivileged;
  });

  const call = (
    shortName: ArchestraToolShortName,
    args: Record<string, unknown>,
  ) =>
    executeArchestraTool(
      archestraMcpBranding.getToolName(shortName),
      args,
      mockContext,
    );
  const findCreated = async (
    result: Awaited<ReturnType<typeof executeArchestraTool>>,
  ) => AgentModel.findById(extractCreatedId(result), mockContext.userId, true);

  async function linkModel(params: {
    keyId: string;
    provider: "anthropic" | "gemini";
    modelId: string;
  }) {
    const model = await ModelModel.create({
      externalId: `${params.provider}/${params.modelId}`,
      provider: params.provider,
      modelId: params.modelId,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(params.keyId, [
      model.id,
    ]);
    return model;
  }

  test("create_agent builds a Claude Code agent the way the catalog card does", async () => {
    const result = await call(TOOL_CREATE_AGENT_SHORT_NAME, {
      name: "Claude Code",
      runtime: { template: "claude-code" },
    });

    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain("Runtime: Claude Code");
    const created = await findCreated(result);
    expect(created?.runtime).toEqual(
      buildAgentCatalogRuntime({
        id: "claude-code",
        image: config.agentRuntime.catalogImages["claude-code"],
      }),
    );
    expect(created?.accessAllTools).toBe(true);
    expect(created?.systemPrompt).toContain("You are Claude Code");
  });

  test("create_agent applies runtime overrides on top of a template", async ({
    makeLlmProviderApiKey,
  }) => {
    const key = await makeLlmProviderApiKey(organizationId, await secretId(), {
      provider: "anthropic",
      access: "org",
    });
    const model = await linkModel({
      keyId: key.id,
      provider: "anthropic",
      modelId: "claude-provider-billing-test",
    });
    const result = await call(TOOL_CREATE_AGENT_SHORT_NAME, {
      name: "Provider-billed Claude Code",
      systemPrompt: "Own prompt",
      accessAllTools: false,
      llmApiKeyId: key.id,
      modelId: model.id,
      runtime: {
        template: "claude-code",
        claudeCode: { authentication: "provider" },
        ttlHours: 4,
        credentials: [
          {
            key: "GITHUB_TOKEN",
            scope: "per_user",
            label: "GitHub token",
            required: true,
          },
        ],
      },
    });

    expect(result.isError).toBe(false);
    const created = await findCreated(result);
    expect(created?.runtime).toMatchObject({
      command: ["archestra-claude-code"],
      inferenceProtocol: "anthropic",
      claudeCode: { authentication: "provider" },
      ttlHours: 4,
      credentials: [expect.objectContaining({ key: "GITHUB_TOKEN" })],
    });
    expect(created?.systemPrompt).toBe("Own prompt");
    expect(created?.accessAllTools).toBe(false);
  });

  test("create_agent fills a custom image's runtime with the page defaults", async () => {
    const result = await call(TOOL_CREATE_AGENT_SHORT_NAME, {
      name: "Custom runtime",
      runtime: {
        image: "example.test/agent:1",
        inferenceProtocol: "openai_chat",
      },
    });

    expect(result.isError).toBe(false);
    expect((await findCreated(result))?.runtime).toEqual({
      ...buildCustomAgentRuntime({ image: "example.test/agent:1" }),
      inferenceProtocol: "openai_chat",
    });
  });

  test("create_agent refuses a runtime the REST route would refuse", async ({
    makeLlmProviderApiKey,
  }) => {
    const before = await AgentModel.findAllPaginated(
      { limit: 100, offset: 0 },
      undefined,
      { organizationId, agentType: "agent" },
      mockContext.userId,
      true,
    );
    const key = await makeLlmProviderApiKey(organizationId, await secretId(), {
      provider: "gemini",
      access: "org",
    });
    const model = await linkModel({
      keyId: key.id,
      provider: "gemini",
      modelId: "runtime-tool-test",
    });

    const incompatible = await call(TOOL_CREATE_AGENT_SHORT_NAME, {
      name: "Codex on Gemini",
      runtime: { template: "codex" },
      llmApiKeyId: key.id,
      modelId: model.id,
    });
    expect(incompatible.isError).toBe(true);
    expect((incompatible.content[0] as any).text).toContain(
      "Codex runtime requires an OpenAI",
    );

    config.agentRuntime.allowPrivileged = false;
    const privileged = await call(TOOL_CREATE_AGENT_SHORT_NAME, {
      name: "Privileged",
      runtime: { template: "codex", privileged: true },
    });
    expect((privileged.content[0] as any).text).toContain(
      "disabled by the deployment operator",
    );

    const wrongTemplateSettings = await call(TOOL_CREATE_AGENT_SHORT_NAME, {
      name: "Codex with Claude settings",
      runtime: {
        template: "codex",
        claudeCode: { authentication: "provider" },
      },
    });
    expect((wrongTemplateSettings.content[0] as any).text).toContain(
      "only to the claude-code template",
    );

    config.agentRuntime.enabled = false;
    const disabled = await call(TOOL_CREATE_AGENT_SHORT_NAME, {
      name: "Runtime off",
      runtime: { template: "claude-code" },
    });
    expect((disabled.content[0] as any).text).toContain(
      "Agent Runtime is not enabled",
    );

    const after = await AgentModel.findAllPaginated(
      { limit: 100, offset: 0 },
      undefined,
      { organizationId, agentType: "agent" },
      mockContext.userId,
      true,
    );
    expect(after.data.length).toBe(before.data.length);
  });

  test("create_agent refuses a template the organization turned off", async () => {
    await OrganizationModel.patch(organizationId, {
      popularAgentOverrides: { codex: { hidden: true } },
    });

    const result = await call(TOOL_CREATE_AGENT_SHORT_NAME, {
      name: "Hidden Codex",
      runtime: { template: "codex" },
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Codex template is turned off",
    );
  });

  test("create_agent pins a model the caller can use and refuses one they cannot", async ({
    makeLlmProviderApiKey,
    makeUser,
  }) => {
    const key = await makeLlmProviderApiKey(organizationId, await secretId(), {
      provider: "anthropic",
      access: "org",
    });
    const model = await linkModel({
      keyId: key.id,
      provider: "anthropic",
      modelId: "claude-tool-test",
    });

    const created = await call(TOOL_CREATE_AGENT_SHORT_NAME, {
      name: "Pinned model",
      llmApiKeyId: key.id,
      modelId: model.id,
    });
    expect(created.isError).toBe(false);
    expect(await findCreated(created)).toMatchObject({
      llmApiKeyId: key.id,
      modelId: model.id,
    });

    const halfPair = await call(TOOL_CREATE_AGENT_SHORT_NAME, {
      name: "Half pair",
      modelId: model.id,
    });
    expect((halfPair.content[0] as any).text).toContain("must be set together");

    const stranger = await makeUser();
    const privateKey = await makeLlmProviderApiKey(
      organizationId,
      await secretId(),
      {
        userId: stranger.id,
        provider: "anthropic",
      },
    );
    const unavailable = await call(TOOL_CREATE_AGENT_SHORT_NAME, {
      name: "Someone else's key",
      llmApiKeyId: privateKey.id,
      modelId: model.id,
    });
    expect((unavailable.content[0] as any).text).toContain(
      "must be linked and available to you",
    );
  });

  test("edit_agent turns a chat agent into a runtime agent and back", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      agentType: "agent",
      authorId: mockContext.userId,
    });

    const toRuntime = await call(TOOL_EDIT_AGENT_SHORT_NAME, {
      id: agent.id,
      runtime: { template: "opencode" },
    });
    expect(toRuntime.isError).toBe(false);
    expect((toRuntime.content[0] as any).text).toContain("Runtime: OpenCode");
    expect((await AgentModel.findById(agent.id))?.runtime).toMatchObject({
      command: ["archestra-opencode"],
    });

    const toChat = await call(TOOL_EDIT_AGENT_SHORT_NAME, {
      id: agent.id,
      runtime: null,
    });
    expect(toChat.isError).toBe(false);
    expect((await AgentModel.findById(agent.id))?.runtime).toBeNull();
  });

  test("edit_agent checks a runtime change against the agent's stored model", async ({
    makeAgent,
    makeLlmProviderApiKey,
  }) => {
    const key = await makeLlmProviderApiKey(organizationId, await secretId(), {
      provider: "gemini",
      access: "org",
    });
    const model = await linkModel({
      keyId: key.id,
      provider: "gemini",
      modelId: "runtime-edit-test",
    });
    const agent = await makeAgent({
      organizationId,
      agentType: "agent",
      authorId: mockContext.userId,
      llmApiKeyId: key.id,
      modelId: model.id,
    });

    const result = await call(TOOL_EDIT_AGENT_SHORT_NAME, {
      id: agent.id,
      runtime: { template: "codex" },
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain(
      "Codex runtime requires an OpenAI",
    );
    expect((await AgentModel.findById(agent.id))?.runtime).toBeNull();
  });

  test("get_agent returns the runtime and pinned model", async ({
    makeAgent,
  }) => {
    const runtime = buildCustomAgentRuntime({ image: "example.test/agent:2" });
    const agent = await makeAgent({
      organizationId,
      agentType: "agent",
      authorId: mockContext.userId,
      runtime,
    });

    const result = await call(TOOL_GET_AGENT_SHORT_NAME, { id: agent.id });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      runtime,
      llmApiKeyId: null,
      modelId: null,
    });
  });

  test("list_llm_models lists the caller's keys with their linked models", async ({
    makeLlmProviderApiKey,
    makeUser,
  }) => {
    const key = await makeLlmProviderApiKey(organizationId, await secretId(), {
      provider: "anthropic",
      access: "org",
    });
    const model = await linkModel({
      keyId: key.id,
      provider: "anthropic",
      modelId: "claude-list-test",
    });
    const stranger = await makeUser();
    const privateKey = await makeLlmProviderApiKey(
      organizationId,
      await secretId(),
      {
        userId: stranger.id,
        provider: "anthropic",
      },
    );

    const result = await call(TOOL_LIST_LLM_MODELS_SHORT_NAME, {});
    expect(result.isError).toBe(false);
    const apiKeys = (result.structuredContent as any).apiKeys;
    expect(apiKeys).toContainEqual({
      id: key.id,
      name: key.name,
      provider: "anthropic",
      models: [{ id: model.id, name: "claude-list-test" }],
      omittedModelCount: 0,
    });
    expect(apiKeys.map((k: { id: string }) => k.id)).not.toContain(
      privateKey.id,
    );

    const filtered = await call(TOOL_LIST_LLM_MODELS_SHORT_NAME, {
      query: "no-such-model",
    });
    expect(
      (filtered.structuredContent as any).apiKeys.find(
        (k: { id: string }) => k.id === key.id,
      ).models,
    ).toEqual([]);
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

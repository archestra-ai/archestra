import {
  ARCHESTRA_MCP_CATALOG_ID,
  TOOL_ACTIVATE_SKILL_FULL_NAME,
  TOOL_CREATE_SKILL_FULL_NAME,
  TOOL_READ_SKILL_FILE_FULL_NAME,
} from "@shared";
import { getArchestraMcpTools } from "@/archestra-mcp-server";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import AgentToolModel from "./agent-tool";
import OrganizationModel from "./organization";
import ToolModel from "./tool";

describe("Archestra Tools Dynamic Assignment", () => {
  test("agents get Archestra tools after explicit assignment", async ({
    makeAgent,
    makeKnowledgeBase,
    seedAndAssignArchestraTools,
  }) => {
    // Create a new agent
    const agent = await makeAgent({ name: "New Agent" });

    // Create a knowledge base and assign to agent so KG tool is visible
    const kg = await makeKnowledgeBase(agent.organizationId);
    await db
      .insert(schema.agentKnowledgeBasesTable)
      .values({ agentId: agent.id, knowledgeBaseId: kg.id });

    // Explicitly seed and assign Archestra tools
    await seedAndAssignArchestraTools(agent.id);

    // Verify agent has Archestra tools assigned
    const toolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
    const archestraToolCount = getArchestraMcpTools().length;
    expect(toolIds).toHaveLength(archestraToolCount);

    // Verify getMcpToolsByAgent returns Archestra tools
    const tools = await ToolModel.getMcpToolsByAgent(agent.id);
    expect(tools).toHaveLength(archestraToolCount);

    // Verify the tool names match
    const toolNames = tools.map((t) => t.name).sort();
    const expectedNames = getArchestraMcpTools()
      .map((t) => t.name)
      .sort();
    expect(toolNames).toEqual(expectedNames);
  });

  test("does not duplicate Archestra tools on subsequent getMcpToolsByAgent calls", async ({
    makeAgent,
    makeKnowledgeBase,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    // Create a knowledge base and assign to agent so KG tool is visible
    const kg = await makeKnowledgeBase(agent.organizationId);
    await db
      .insert(schema.agentKnowledgeBasesTable)
      .values({ agentId: agent.id, knowledgeBaseId: kg.id });

    // Seed and assign Archestra tools first
    await seedAndAssignArchestraTools(agent.id);

    // First call
    const firstCall = await ToolModel.getMcpToolsByAgent(agent.id);
    const firstCount = firstCall.length;

    // Second call - should not duplicate
    const secondCall = await ToolModel.getMcpToolsByAgent(agent.id);
    const secondCount = secondCall.length;

    expect(firstCount).toBe(secondCount);
    expect(firstCount).toBeGreaterThan(0);
  });

  test("getMcpToolsByAgent includes both Archestra and MCP server tools", async ({
    makeAgent,
    makeKnowledgeBase,
    makeTool,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent({ name: "Test Agent" });

    // Create a knowledge base and assign to agent so KG tool is visible
    const kg = await makeKnowledgeBase(agent.organizationId);
    await db
      .insert(schema.agentKnowledgeBasesTable)
      .values({ agentId: agent.id, knowledgeBaseId: kg.id });

    // Seed and assign Archestra tools first
    await seedAndAssignArchestraTools(agent.id);

    // Create an MCP server tool
    const catalogItem = await makeInternalMcpCatalog({
      name: "test-mcp-server",
      serverUrl: "https://test.com/mcp/",
    });

    await makeMcpServer({
      name: "test-server",
      catalogId: catalogItem.id,
      ownerId: user.id,
    });

    const mcpTool = await makeTool({
      name: "test_mcp_tool",
      description: "Test MCP tool",
      parameters: {},
      catalogId: catalogItem.id,
    });

    // Assign MCP tool to agent
    await AgentToolModel.create(agent.id, mcpTool.id);

    // Get all tools - should include Archestra + MCP server tool
    const tools = await ToolModel.getMcpToolsByAgent(agent.id);

    const archestraToolCount = getArchestraMcpTools().length;
    expect(tools).toHaveLength(archestraToolCount + 1); // Archestra tools + 1 MCP tool

    // Verify MCP tool is included
    const mcpToolFound = tools.find((t) => t.name === "test_mcp_tool");
    expect(mcpToolFound).toBeDefined();

    // Verify Archestra tools are included
    const archestraToolNames = getArchestraMcpTools().map((t) => t.name);
    for (const name of archestraToolNames) {
      const archestraToolFound = tools.find((t) => t.name === name);
      expect(archestraToolFound).toBeDefined();
    }
  });

  test("does not include proxy-discovered tools in getMcpToolsByAgent", async ({
    makeAgent,
    makeKnowledgeBase,
    makeTool,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    // Create a knowledge base and assign to agent so KG tool is visible
    const kg = await makeKnowledgeBase(agent.organizationId);
    await db
      .insert(schema.agentKnowledgeBasesTable)
      .values({ agentId: agent.id, knowledgeBaseId: kg.id });

    // Seed and assign Archestra tools first
    await seedAndAssignArchestraTools(agent.id);

    // Create a proxy-discovered tool (agentId set, catalogId null)
    await makeTool({
      agentId: agent.id,
      name: "proxy_discovered_tool",
      description: "Proxy discovered tool",
      parameters: {},
    });

    // Get MCP tools - should NOT include proxy-discovered tool
    const tools = await ToolModel.getMcpToolsByAgent(agent.id);

    const proxyTool = tools.find((t) => t.name === "proxy_discovered_tool");
    expect(proxyTool).toBeUndefined();

    // Should only have Archestra tools (proxy-discovered tools are excluded)
    const archestraToolCount = getArchestraMcpTools().length;
    expect(tools).toHaveLength(archestraToolCount);
  });

  test("backfillSkillToolsToOrgAgents assigns the skill tools to every agent in the org", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agentA = await makeAgent({
      organizationId: org.id,
      name: "Agent A",
    });
    const agentB = await makeAgent({
      organizationId: org.id,
      name: "Agent B",
    });

    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const count = await ToolModel.backfillSkillToolsToOrgAgents(org.id);
    expect(count).toBe(2);

    const skillToolNames = [
      TOOL_ACTIVATE_SKILL_FULL_NAME,
      TOOL_READ_SKILL_FILE_FULL_NAME,
      TOOL_CREATE_SKILL_FULL_NAME,
    ];
    for (const agentId of [agentA.id, agentB.id]) {
      const tools = await ToolModel.getMcpToolsByAgent(agentId);
      const names = tools.map((t) => t.name);
      for (const skillTool of skillToolNames) {
        expect(names).toContain(skillTool);
      }
    }
  });

  test("backfillSkillToolsToOrgAgents covers mcp_gateway agents too", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const gateway = await makeAgent({
      organizationId: org.id,
      name: "My Gateway",
      agentType: "mcp_gateway",
      scope: "personal",
    });

    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    await ToolModel.backfillSkillToolsToOrgAgents(org.id);

    const names = (await ToolModel.getMcpToolsByAgent(gateway.id)).map(
      (t) => t.name,
    );
    expect(names).toContain(TOOL_ACTIVATE_SKILL_FULL_NAME);
    expect(names).toContain(TOOL_READ_SKILL_FILE_FULL_NAME);
  });

  test("backfillSkillToolsToOrgAgents is idempotent", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id, name: "Agent" });

    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    await ToolModel.backfillSkillToolsToOrgAgents(org.id);
    await ToolModel.backfillSkillToolsToOrgAgents(org.id);

    const toolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
    expect(new Set(toolIds).size).toBe(toolIds.length);
  });

  test("backfillSkillToolsToOrgAgents does not touch agents in other orgs", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    await makeAgent({ organizationId: orgA.id, name: "In A" });
    const agentB = await makeAgent({ organizationId: orgB.id, name: "In B" });

    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    await ToolModel.backfillSkillToolsToOrgAgents(orgA.id);

    const toolsB = await ToolModel.getMcpToolsByAgent(agentB.id);
    expect(toolsB.map((t) => t.name)).not.toContain(
      TOOL_ACTIVATE_SKILL_FULL_NAME,
    );
  });

  test("backfillSkillToolsToOrgAgents skips soft-deleted agents", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const activeAgent = await makeAgent({
      organizationId: org.id,
      name: "Active Agent",
    });
    const deletedAgent = await makeAgent({
      organizationId: org.id,
      name: "Deleted Agent",
    });

    await AgentModel.delete(deletedAgent.id);
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

    const count = await ToolModel.backfillSkillToolsToOrgAgents(org.id);

    expect(count).toBe(1);
    const activeTools = await ToolModel.getMcpToolsByAgent(activeAgent.id);
    expect(activeTools.map((tool) => tool.name)).toContain(
      TOOL_ACTIVATE_SKILL_FULL_NAME,
    );

    const deletedToolIds = await AgentToolModel.findToolIdsByAgent(
      deletedAgent.id,
    );
    expect(deletedToolIds).toHaveLength(0);
  });

  test("assignSkillToolsToAgent no-ops when org flag is off", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id, name: "Agent" });

    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    await ToolModel.assignSkillToolsToAgent(agent.id, org.id);

    const tools = await ToolModel.getMcpToolsByAgent(agent.id);
    expect(tools.map((t) => t.name)).not.toContain(
      TOOL_ACTIVATE_SKILL_FULL_NAME,
    );
  });

  test("assignSkillToolsToAgent assigns when org flag is on", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id, name: "Agent" });
    await OrganizationModel.patch(org.id, { skillToolsEnabled: true });

    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    await ToolModel.assignSkillToolsToAgent(agent.id, org.id);

    const names = (await ToolModel.getMcpToolsByAgent(agent.id)).map(
      (t) => t.name,
    );
    expect(names).toContain(TOOL_ACTIVATE_SKILL_FULL_NAME);
    expect(names).toContain(TOOL_READ_SKILL_FILE_FULL_NAME);
  });

  test("backfillNewSkillToolsToEnabledOrgs backfills agents of opted-in orgs when a skill tool first appears", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const enabledOrg = await makeOrganization();
    const disabledOrg = await makeOrganization();
    await OrganizationModel.patch(enabledOrg.id, { skillToolsEnabled: true });
    const enabledAgent = await makeAgent({
      organizationId: enabledOrg.id,
      name: "Enabled Agent",
    });
    const disabledAgent = await makeAgent({
      organizationId: disabledOrg.id,
      name: "Disabled Agent",
    });

    // first seed reports every built-in tool as newly created, including the skill tools
    const newToolNames = await ToolModel.seedArchestraTools(
      ARCHESTRA_MCP_CATALOG_ID,
    );
    await ToolModel.backfillNewSkillToolsToEnabledOrgs(newToolNames);

    const enabledNames = (
      await ToolModel.getMcpToolsByAgent(enabledAgent.id)
    ).map((t) => t.name);
    expect(enabledNames).toContain(TOOL_CREATE_SKILL_FULL_NAME);

    // org that never opted in is left untouched
    const disabledNames = (
      await ToolModel.getMcpToolsByAgent(disabledAgent.id)
    ).map((t) => t.name);
    expect(disabledNames).not.toContain(TOOL_CREATE_SKILL_FULL_NAME);
  });

  test("backfillNewSkillToolsToEnabledOrgs is a no-op when no skill tools were created", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, { skillToolsEnabled: true });
    const agent = await makeAgent({ organizationId: org.id, name: "Agent" });

    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    // a re-seed creates nothing new; passing a non-skill tool name must not backfill
    await ToolModel.backfillNewSkillToolsToEnabledOrgs([]);

    const names = (await ToolModel.getMcpToolsByAgent(agent.id)).map(
      (t) => t.name,
    );
    expect(names).not.toContain(TOOL_CREATE_SKILL_FULL_NAME);
  });
});

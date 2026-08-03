import {
  APP_ARCHESTRA_TOOL_SHORT_NAMES,
  ARCHESTRA_MCP_CATALOG_ID,
  DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
  getArchestraToolFullName,
  getCreationDefaultArchestraToolShortNames,
  PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
  TOOL_ADVISOR_FULL_NAME,
  TOOL_CREATE_SKILL_FULL_NAME,
  TOOL_DOWNLOAD_FILE_FULL_NAME,
  TOOL_LOAD_SKILL_FULL_NAME,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_UPLOAD_FILE_FULL_NAME,
} from "@archestra/shared";
import { and, eq, inArray } from "drizzle-orm";
import { getArchestraMcpTools } from "@/archestra-mcp-server";
import config from "@/config";
import db, { schema } from "@/database";
import { beforeEach, describe, expect, test } from "@/test";
import AgentModel from "./agent";
import AgentToolModel from "./agent-tool";
import OrganizationModel from "./organization";
import ToolModel from "./tool";

describe("Archestra Tools Dynamic Assignment", () => {
  // Pin the sandbox flag that gates create-time tool assignment. Tests below
  // assert EXACT assigned-tool sets and toggle the flag themselves (with
  // try/finally); trusting the worker baseline let a rare cross-file ordering
  // surface sandbox tools in counts that expected zero.
  beforeEach(() => {
    (config.skillsSandbox as { enabled: boolean }).enabled = false;
  });

  /**
   * Names of the tools assigned to the agent, straight from the junction
   * table (no query-time filtering like the knowledge-tool visibility gate).
   */
  async function assignedToolNames(agentId: string): Promise<string[]> {
    const rows = await db
      .select({ name: schema.toolsTable.name })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(eq(schema.agentToolsTable.agentId, agentId));
    return rows.map((row) => row.name);
  }

  /** Catalog tool ids for every short name in the default set. */
  async function defaultToolIds(): Promise<string[]> {
    const names = DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES.map((n) =>
      getArchestraToolFullName(n),
    );
    const rows = await db
      .select({ id: schema.toolsTable.id })
      .from(schema.toolsTable)
      .where(inArray(schema.toolsTable.name, names as string[]));
    return rows.map((r) => r.id);
  }

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
      TOOL_LOAD_SKILL_FULL_NAME,
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
    expect(names).toContain(TOOL_LOAD_SKILL_FULL_NAME);
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
    expect(toolsB.map((t) => t.name)).not.toContain(TOOL_LOAD_SKILL_FULL_NAME);
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
      TOOL_LOAD_SKILL_FULL_NAME,
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
    expect(tools.map((t) => t.name)).not.toContain(TOOL_LOAD_SKILL_FULL_NAME);
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
    expect(names).toContain(TOOL_LOAD_SKILL_FULL_NAME);
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

  test("AgentModel.create assigns app tools", async ({ makeAgent }) => {
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const agent = await makeAgent({ name: "Apps Agent" });

    const names = (await ToolModel.getMcpToolsByAgent(agent.id)).map(
      (t) => t.name,
    );
    for (const shortName of APP_ARCHESTRA_TOOL_SHORT_NAMES) {
      expect(names).toContain(getArchestraToolFullName(shortName));
    }
  });

  test("AgentModel.create assigns sandbox runtime and file tools when the runtime is enabled", async ({
    makeAgent,
  }) => {
    const sandboxConfig = config.skillsSandbox as { enabled: boolean };
    const originalSandbox = sandboxConfig.enabled;
    sandboxConfig.enabled = true;
    try {
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
      const agent = await makeAgent({ name: "Sandbox Agent" });

      const names = (await ToolModel.getMcpToolsByAgent(agent.id)).map(
        (t) => t.name,
      );
      for (const fullName of [
        TOOL_RUN_COMMAND_FULL_NAME,
        TOOL_UPLOAD_FILE_FULL_NAME,
        TOOL_DOWNLOAD_FILE_FULL_NAME,
      ]) {
        expect(names).toContain(fullName);
      }
      for (const shortName of PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES) {
        expect(names).toContain(getArchestraToolFullName(shortName));
      }
    } finally {
      sandboxConfig.enabled = originalSandbox;
    }
  });

  test("AgentModel.create assigns the always-on default tools in the general create path", async ({
    makeAgent,
  }) => {
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const agent = await makeAgent({ name: "Defaults Agent" });

    const names = await assignedToolNames(agent.id);
    for (const shortName of DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES) {
      expect(names).toContain(getArchestraToolFullName(shortName));
    }
  });

  test("AgentModel.create assigns exactly the shared creation-default composer set with every flag on", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const sandboxConfig = config.skillsSandbox as { enabled: boolean };
    const originalSandbox = sandboxConfig.enabled;
    sandboxConfig.enabled = true;
    try {
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
      const org = await makeOrganization();
      await OrganizationModel.patch(org.id, { skillToolsEnabled: true });

      const agent = await makeAgent({
        organizationId: org.id,
        name: "Composer Agent",
      });

      const expected = getCreationDefaultArchestraToolShortNames({
        skillsEnabled: true,
        sandboxEnabled: true,
      })
        .map((shortName) => getArchestraToolFullName(shortName))
        .sort();
      expect((await assignedToolNames(agent.id)).sort()).toEqual(expected);
    } finally {
      sandboxConfig.enabled = originalSandbox;
    }
  });

  test("backfillDefaultToolsToAgents repairs an agent that is missing a default tool, and leaves built-in system agents alone", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

    const agent = await makeAgent({ organizationId: org.id, name: "Chat" });
    const [builtInAgent] = await db
      .insert(schema.agentsTable)
      .values({
        organizationId: org.id,
        name: "System Agent",
        agentType: "agent",
        scope: "org",
        builtInAgentConfig: { name: "advisor-agent" },
      })
      .returning();

    // The state a two-stage rollout leaves behind: the tool row exists but the
    // agent never received it, and no later seed reports it as newly created.
    const seededIds = await defaultToolIds();
    for (const toolId of seededIds) {
      await db
        .delete(schema.agentToolsTable)
        .where(eq(schema.agentToolsTable.toolId, toolId));
    }
    expect(await assignedToolNames(agent.id)).not.toContain(
      TOOL_ADVISOR_FULL_NAME,
    );

    await ToolModel.backfillDefaultToolsToAgents();

    const repaired = await assignedToolNames(agent.id);
    for (const shortName of DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES) {
      expect(repaired).toContain(getArchestraToolFullName(shortName));
    }
    // An advisor must not be handed the advisor tool.
    expect(await assignedToolNames(builtInAgent.id)).not.toContain(
      TOOL_ADVISOR_FULL_NAME,
    );
  });

  test("backfillDefaultToolsToAgents is idempotent across repeated boots", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const agent = await makeAgent({ organizationId: org.id, name: "Chat" });

    await ToolModel.backfillDefaultToolsToAgents();
    const afterFirst = await assignedToolNames(agent.id);
    await ToolModel.backfillDefaultToolsToAgents();
    const afterSecond = await assignedToolNames(agent.id);

    expect(afterSecond.sort()).toEqual(afterFirst.sort());
  });

  test("backfillDefaultToolsToAgents clears a stale exclusion that would refuse an assigned default tool", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "All-tools",
      accessAllTools: true,
    });
    const toolIds = await defaultToolIds();

    // The state an older build leaves: the Auto-mode pre-fill excluded the
    // tool while it was still a non-default, and the assignment arrived later
    // when it joined the default set. Dispatch then refuses a tool the agent
    // holds. The exclusion predating the assignment is what marks it stale.
    await db
      .insert(schema.agentExcludedToolsTable)
      .values(
        toolIds.map((toolId) => ({
          agentId: agent.id,
          toolId,
          createdAt: new Date("2026-01-01T00:00:00Z"),
        })),
      )
      .onConflictDoNothing();
    await AgentToolModel.createManyIfNotExists(agent.id, toolIds);
    const excludedDefaults = async () =>
      db
        .select()
        .from(schema.agentExcludedToolsTable)
        .where(
          and(
            eq(schema.agentExcludedToolsTable.agentId, agent.id),
            inArray(schema.agentExcludedToolsTable.toolId, toolIds),
          ),
        );
    expect((await excludedDefaults()).length).toBe(toolIds.length);

    await ToolModel.backfillDefaultToolsToAgents();

    expect(await excludedDefaults()).toHaveLength(0);
    // Auto-mode exclusions for non-default built-ins are left alone.
    const remaining = await db
      .select()
      .from(schema.agentExcludedToolsTable)
      .where(eq(schema.agentExcludedToolsTable.agentId, agent.id));
    expect(remaining.length).toBeGreaterThan(0);
  });

  test("backfillDefaultToolsToAgents keeps an exclusion an admin added after the tool was assigned", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "All-tools",
      accessAllTools: true,
    });
    const [advisorToolId] = await db
      .select({ id: schema.toolsTable.id })
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.name, TOOL_ADVISOR_FULL_NAME));

    // Excluding a default tool is the only way to take it off an Auto-mode
    // agent, so the row an admin creates must outlive a boot. It is told apart
    // from the stale pre-fill row by arriving after the assignment.
    await AgentToolModel.createManyIfNotExists(agent.id, [advisorToolId.id]);
    await db.insert(schema.agentExcludedToolsTable).values({
      agentId: agent.id,
      toolId: advisorToolId.id,
      createdAt: new Date("2099-01-01T00:00:00Z"),
    });

    await ToolModel.backfillDefaultToolsToAgents();

    const kept = await db
      .select()
      .from(schema.agentExcludedToolsTable)
      .where(
        and(
          eq(schema.agentExcludedToolsTable.agentId, agent.id),
          eq(schema.agentExcludedToolsTable.toolId, advisorToolId.id),
        ),
      );
    expect(kept).toHaveLength(1);
  });

  test("findAgentIdsMissingAnyTool returns only agents missing at least one tool", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const toolIds = await defaultToolIds();
    expect(toolIds.length).toBeGreaterThan(1);

    const complete = await makeAgent({ organizationId: org.id, name: "Full" });
    const partial = await makeAgent({
      organizationId: org.id,
      name: "Partial",
    });
    // Clear what create-time assignment already granted, so the two agents
    // differ only by what this test gives them.
    for (const id of [complete.id, partial.id]) {
      await db
        .delete(schema.agentToolsTable)
        .where(eq(schema.agentToolsTable.agentId, id));
    }
    await AgentToolModel.createManyIfNotExists(complete.id, toolIds);
    await AgentToolModel.createManyIfNotExists(partial.id, toolIds.slice(0, 1));

    const missing = await AgentToolModel.findAgentIdsMissingAnyTool(
      [complete.id, partial.id],
      toolIds,
    );

    expect(missing).toEqual([partial.id]);
    expect(
      await AgentToolModel.findAgentIdsMissingAnyTool([], toolIds),
    ).toEqual([]);
    expect(
      await AgentToolModel.findAgentIdsMissingAnyTool([complete.id], []),
    ).toEqual([]);
  });

  test("backfillNewSandboxToolsToAgents assigns the new sandbox tools to every agent kind, skipping built-in system agents", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    // Agents created while the runtime is off (the beforeEach pins the flag
    // false): the create-time sandbox assignment no-ops for all of them.
    const chatAgent = await makeAgent({
      organizationId: org.id,
      name: "Chat Agent",
    });
    const allToolsAgent = await makeAgent({
      organizationId: org.id,
      name: "All-tools Agent",
      accessAllTools: true,
    });
    const gateway = await makeAgent({
      organizationId: org.id,
      name: "Gateway",
      agentType: "mcp_gateway",
      scope: "personal",
    });
    const [builtInAgent] = await db
      .insert(schema.agentsTable)
      .values({
        organizationId: org.id,
        name: "System Agent",
        agentType: "agent",
        scope: "org",
        builtInAgentConfig: { name: "app-runtime-llm-agent" },
      })
      .returning();

    const sandboxConfig = config.skillsSandbox as { enabled: boolean };
    const originalSandbox = sandboxConfig.enabled;
    sandboxConfig.enabled = true;
    try {
      // First seed with the runtime on: the sandbox tools are newly created.
      const newToolNames = await ToolModel.seedArchestraTools(
        ARCHESTRA_MCP_CATALOG_ID,
      );
      await ToolModel.backfillNewSandboxToolsToAgents(newToolNames);
    } finally {
      sandboxConfig.enabled = originalSandbox;
    }

    for (const agent of [chatAgent, allToolsAgent, gateway]) {
      const names = await assignedToolNames(agent.id);
      expect(names).toContain(TOOL_RUN_COMMAND_FULL_NAME);
      for (const shortName of PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES) {
        expect(names).toContain(getArchestraToolFullName(shortName));
      }
    }
    expect(await assignedToolNames(builtInAgent.id)).not.toContain(
      TOOL_RUN_COMMAND_FULL_NAME,
    );
  });

  test("backfillNewSandboxToolsToAgents is idempotent and only assigns the newly created short names", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id, name: "Agent" });

    const sandboxConfig = config.skillsSandbox as { enabled: boolean };
    const originalSandbox = sandboxConfig.enabled;
    sandboxConfig.enabled = true;
    try {
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
      // Simulate a later boot where only run_command is newly created.
      await ToolModel.backfillNewSandboxToolsToAgents([
        TOOL_RUN_COMMAND_FULL_NAME,
      ]);
      await ToolModel.backfillNewSandboxToolsToAgents([
        TOOL_RUN_COMMAND_FULL_NAME,
      ]);
    } finally {
      sandboxConfig.enabled = originalSandbox;
    }

    const names = await assignedToolNames(agent.id);
    expect(
      names.filter((name) => name === TOOL_RUN_COMMAND_FULL_NAME),
    ).toHaveLength(1);
    expect(names).not.toContain(TOOL_UPLOAD_FILE_FULL_NAME);
  });

  test("backfillNewSandboxToolsToAgents is a no-op when no sandbox tools were created", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id, name: "Agent" });

    const sandboxConfig = config.skillsSandbox as { enabled: boolean };
    const originalSandbox = sandboxConfig.enabled;
    sandboxConfig.enabled = true;
    try {
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
      // A re-seed creates nothing new; a non-sandbox name must not backfill.
      await ToolModel.backfillNewSandboxToolsToAgents([
        TOOL_LOAD_SKILL_FULL_NAME,
      ]);
    } finally {
      sandboxConfig.enabled = originalSandbox;
    }

    expect(await assignedToolNames(agent.id)).not.toContain(
      TOOL_RUN_COMMAND_FULL_NAME,
    );
  });

  test("AgentModel.create assigns no sandbox or file tools when the runtime is disabled", async ({
    makeAgent,
  }) => {
    const sandboxConfig = config.skillsSandbox as { enabled: boolean };
    const originalSandbox = sandboxConfig.enabled;
    // Seed with the runtime on so the tools exist; turning it off must keep
    // the whole sandbox group off the new agent.
    sandboxConfig.enabled = true;
    try {
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
      sandboxConfig.enabled = false;
      const agent = await makeAgent({ name: "No Runtime Agent" });

      const names = (await ToolModel.getMcpToolsByAgent(agent.id)).map(
        (t) => t.name,
      );
      for (const fullName of [
        TOOL_RUN_COMMAND_FULL_NAME,
        TOOL_UPLOAD_FILE_FULL_NAME,
        TOOL_DOWNLOAD_FILE_FULL_NAME,
        ...PROJECTS_FILE_ARCHESTRA_TOOL_SHORT_NAMES.map(
          getArchestraToolFullName,
        ),
      ]) {
        expect(names).not.toContain(fullName);
      }
    } finally {
      sandboxConfig.enabled = originalSandbox;
    }
  });
});

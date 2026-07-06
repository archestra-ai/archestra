import {
  ARCHESTRA_MCP_CATALOG_ID,
  TOOL_CREATE_AGENT_FULL_NAME,
  TOOL_GET_AGENT_FULL_NAME,
  TOOL_LIST_AGENTS_FULL_NAME,
  TOOL_LIST_SKILLS_FULL_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import AgentExcludedToolModel from "@/models/agent-excluded-tool";
import ToolModel from "@/models/tool";
import { describe, expect, test } from "@/test";

/** Id of a seeded built-in tool, by its full (default-prefixed) name. */
async function builtInToolId(name: string): Promise<string> {
  const tool = await ToolModel.findByName(name);
  if (!tool) throw new Error(`Built-in tool not seeded: ${name}`);
  return tool.id;
}

describe("AgentExcludedToolModel", () => {
  test("returns an empty set for an agent without exclusions", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    expect(await AgentExcludedToolModel.findToolIdsByAgent(agent.id)).toEqual(
      [],
    );
    expect(
      await AgentExcludedToolModel.findExcludedToolRowsByAgent(agent.id),
    ).toEqual([]);
  });

  test("replaceForAgent fully replaces the excluded tool set", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const toolA = await makeTool({ name: "srv__a", catalogId: catalog.id });
    const toolB = await makeTool({ name: "srv__b", catalogId: catalog.id });

    await AgentExcludedToolModel.replaceForAgent(agent.id, [toolA.id]);
    expect(await AgentExcludedToolModel.findToolIdsByAgent(agent.id)).toEqual([
      toolA.id,
    ]);

    await AgentExcludedToolModel.replaceForAgent(agent.id, [toolB.id]);
    expect(await AgentExcludedToolModel.findToolIdsByAgent(agent.id)).toEqual([
      toolB.id,
    ]);

    await AgentExcludedToolModel.replaceForAgent(agent.id, []);
    expect(await AgentExcludedToolModel.findToolIdsByAgent(agent.id)).toEqual(
      [],
    );
  });

  test("findExcludedToolRowsByAgent joins the tool identity and meta", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      name: "github__create_issue",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: "ui://github/view.html" } } },
    });

    await AgentExcludedToolModel.replaceForAgent(agent.id, [tool.id]);

    expect(
      await AgentExcludedToolModel.findExcludedToolRowsByAgent(agent.id),
    ).toEqual([
      {
        toolId: tool.id,
        name: "github__create_issue",
        catalogId: catalog.id,
        meta: { _meta: { ui: { resourceUri: "ui://github/view.html" } } },
      },
    ]);
  });

  test("rows cascade away when the tool is deleted", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({ name: "srv__x", catalogId: catalog.id });
    await AgentExcludedToolModel.replaceForAgent(agent.id, [tool.id]);

    await db.delete(schema.toolsTable).where(eq(schema.toolsTable.id, tool.id));

    expect(await AgentExcludedToolModel.findToolIdsByAgent(agent.id)).toEqual(
      [],
    );
  });

  test("rows cascade away when the agent is deleted", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({ name: "srv__y", catalogId: catalog.id });
    await AgentExcludedToolModel.replaceForAgent(agent.id, [tool.id]);

    await db
      .delete(schema.agentsTable)
      .where(eq(schema.agentsTable.id, agent.id));

    const rows = await db
      .select()
      .from(schema.agentExcludedToolsTable)
      .where(eq(schema.agentExcludedToolsTable.agentId, agent.id));
    expect(rows).toEqual([]);
  });
});

describe("All-tools exclusion pre-fill", () => {
  test("prefillForAllToolsMode is additive and idempotent, skipping exempt and assigned built-ins", async ({
    makeAgent,
    makeAgentTool,
  }) => {
    // Seed with the sandbox runtime on so run_command exists as a catalog row
    // and its exemption is actually exercised; flip the flag back before
    // creating the agent so create-time auto-assignment stays out of the way.
    const sandboxConfig = config.skillsSandbox as { enabled: boolean };
    const originalSandboxEnabled = sandboxConfig.enabled;
    sandboxConfig.enabled = true;
    try {
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    } finally {
      sandboxConfig.enabled = originalSandboxEnabled;
    }

    const agent = await makeAgent();
    const assignedId = await builtInToolId(TOOL_LIST_AGENTS_FULL_NAME);
    await makeAgentTool(agent.id, assignedId);

    // Pre-existing manual exclusion row: must survive the pre-fill untouched.
    const manualId = await builtInToolId(TOOL_GET_AGENT_FULL_NAME);
    await AgentExcludedToolModel.replaceForAgent(agent.id, [manualId]);

    const insertedCount = await AgentExcludedToolModel.prefillForAllToolsMode(
      agent.id,
    );
    expect(insertedCount).toBeGreaterThan(0);

    const excluded = new Set(
      await AgentExcludedToolModel.findToolIdsByAgent(agent.id),
    );
    // Unassigned management built-in is excluded; the manual row is kept.
    expect(excluded.has(await builtInToolId(TOOL_CREATE_AGENT_FULL_NAME))).toBe(
      true,
    );
    expect(excluded.has(manualId)).toBe(true);
    // Assigned tools are never pre-excluded.
    expect(excluded.has(assignedId)).toBe(false);
    // Exempt set is never inserted: dispatch surface, KB query, sandbox,
    // skills.
    expect(excluded.has(await builtInToolId(TOOL_SEARCH_TOOLS_FULL_NAME))).toBe(
      false,
    );
    expect(excluded.has(await builtInToolId(TOOL_RUN_TOOL_FULL_NAME))).toBe(
      false,
    );
    expect(
      excluded.has(await builtInToolId(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME)),
    ).toBe(false);
    expect(excluded.has(await builtInToolId(TOOL_RUN_COMMAND_FULL_NAME))).toBe(
      false,
    );
    expect(excluded.has(await builtInToolId(TOOL_LIST_SKILLS_FULL_NAME))).toBe(
      false,
    );

    // Second run is a no-op: nothing inserted, the set is unchanged.
    const secondCount = await AgentExcludedToolModel.prefillForAllToolsMode(
      agent.id,
    );
    expect(secondCount).toBe(0);
    expect(
      new Set(await AgentExcludedToolModel.findToolIdsByAgent(agent.id)),
    ).toEqual(excluded);
  });

  test("prefillNewBuiltInToolsForAllToolsAgents targets only All-tools agents and skips assigned/exempt tools", async ({
    makeAgent,
    makeAgentTool,
  }) => {
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

    const allModeAgent = await makeAgent({ accessAllTools: true });
    const customAgent = await makeAgent({ accessAllTools: false });

    const newToolId = await builtInToolId(TOOL_LIST_AGENTS_FULL_NAME);
    const assignedToolId = await builtInToolId(TOOL_GET_AGENT_FULL_NAME);
    const exemptToolId = await builtInToolId(TOOL_SEARCH_TOOLS_FULL_NAME);

    // Simulate the "tools are brand new" state: clear the create-time pre-fill
    // rows for the pair under test, then assign one of them to the agent.
    const remaining = (
      await AgentExcludedToolModel.findToolIdsByAgent(allModeAgent.id)
    ).filter((id) => id !== newToolId && id !== assignedToolId);
    await AgentExcludedToolModel.replaceForAgent(allModeAgent.id, remaining);
    await makeAgentTool(allModeAgent.id, assignedToolId);

    await AgentExcludedToolModel.prefillNewBuiltInToolsForAllToolsAgents([
      newToolId,
      assignedToolId,
      exemptToolId,
    ]);

    const allModeExcluded = new Set(
      await AgentExcludedToolModel.findToolIdsByAgent(allModeAgent.id),
    );
    expect(allModeExcluded.has(newToolId)).toBe(true);
    expect(allModeExcluded.has(assignedToolId)).toBe(false);
    expect(allModeExcluded.has(exemptToolId)).toBe(false);

    // Custom-mode agents are untouched by the seed-time backfill.
    expect(
      await AgentExcludedToolModel.findToolIdsByAgent(customAgent.id),
    ).toEqual([]);
  });

  test("prefillNewBuiltInToolsForAllToolsAgents with no tool ids is a no-op", async () => {
    expect(
      await AgentExcludedToolModel.prefillNewBuiltInToolsForAllToolsAgents([]),
    ).toBe(0);
  });
});

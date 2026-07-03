import {
  ARCHESTRA_MCP_CATALOG_ID,
  TOOL_CREATE_AGENT_FULL_NAME,
  TOOL_LIST_AGENTS_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
} from "@archestra/shared";
import {
  AgentExcludedToolModel,
  AgentModel,
  AgentToolModel,
  ToolModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import type { AgentExportPayload } from "@/types/agent-export";
import { serializeAgentForExport } from "./agent-export";
import { importAgentFromPayload } from "./agent-import";

/**
 * Helper to create a minimal valid import payload.
 */
function makePayload(
  overrides: Partial<AgentExportPayload> = {},
): AgentExportPayload {
  return {
    version: "1",
    exportedAt: new Date().toISOString(),
    sourceInstance: null,
    agent: {
      name: "Import Test Agent",
      agentType: "agent",
      description: "A test agent for import",
      systemPrompt: "You are a helpful assistant",
      icon: "🤖",
      scope: "org", // Should be overridden to personal
      considerContextUntrusted: false,
      toolExposureMode: "full",
      accessAllTools: false,
      incomingEmailEnabled: false,
      incomingEmailSecurityMode: "private",
      incomingEmailAllowedDomain: null,
      passthroughHeaders: null,
    },
    labels: [],
    suggestedPrompts: [],
    tools: [],
    delegations: [],
    knowledgeBases: [],
    connectors: [],
    ...overrides,
  };
}

describe("importAgentFromPayload", () => {
  test("imports a basic agent with correct fields", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const result = await importAgentFromPayload(makePayload(), user.id, org.id);

    expect(result.agent.name).toBe("Import Test Agent");
    expect(result.agent.agentType).toBe("agent");
    expect(result.agent.description).toBe("A test agent for import");
    expect(result.agent.systemPrompt).toBe("You are a helpful assistant");
    expect(result.warnings).toHaveLength(0);
  });

  test("always creates agent with personal scope regardless of payload", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const result = await importAgentFromPayload(
      makePayload({ agent: { ...makePayload().agent, scope: "org" } }),
      user.id,
      org.id,
    );

    expect(result.agent.scope).toBe("personal");
  });

  test("appends (imported) suffix on name collision", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    // Create an existing agent with the same name
    await makeAgent({
      name: "My Agent",
      organizationId: org.id,
      authorId: user.id,
    });

    const result = await importAgentFromPayload(
      makePayload({
        agent: { ...makePayload().agent, name: "My Agent" },
      }),
      user.id,
      org.id,
    );

    expect(result.agent.name).toBe("My Agent (imported)");
    expect(result.warnings).toHaveLength(0);
  });

  test("returns warnings for missing tools", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const result = await importAgentFromPayload(
      makePayload({
        tools: [
          {
            toolName: "nonexistent-tool",
            catalogName: "fake-catalog",
            credentialResolutionMode: "dynamic",
          },
        ],
      }),
      user.id,
      org.id,
    );

    expect(result.agent).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe("tool");
    expect(result.warnings[0].name).toBe("nonexistent-tool");
  });

  test("returns warnings for missing knowledge bases", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const result = await importAgentFromPayload(
      makePayload({
        knowledgeBases: [{ name: "Nonexistent KB" }],
      }),
      user.id,
      org.id,
    );

    expect(result.agent).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe("knowledgeBase");
    expect(result.warnings[0].name).toBe("Nonexistent KB");
  });

  test("returns warnings for missing connectors", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const result = await importAgentFromPayload(
      makePayload({
        connectors: [
          { name: "Missing Connector", connectorType: "confluence" },
        ],
      }),
      user.id,
      org.id,
    );

    expect(result.agent).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe("connector");
    expect(result.warnings[0].name).toBe("Missing Connector");
  });

  test("returns warnings for missing delegation targets", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const result = await importAgentFromPayload(
      makePayload({
        delegations: [{ targetAgentName: "Nonexistent Agent" }],
      }),
      user.id,
      org.id,
    );

    expect(result.agent).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe("delegation");
    expect(result.warnings[0].name).toBe("Nonexistent Agent");
  });

  test("returns warnings for soft-deleted delegation targets", async ({
    makeAgent,
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const targetAgent = await makeAgent({
      name: "Deleted Delegate",
      organizationId: org.id,
    });
    await AgentModel.delete(targetAgent.id);

    const result = await importAgentFromPayload(
      makePayload({
        delegations: [{ targetAgentName: targetAgent.name }],
      }),
      user.id,
      org.id,
    );

    expect(result.agent).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe("delegation");
    expect(result.warnings[0].name).toBe(targetAgent.name);
  });

  test("imports labels and suggested prompts correctly", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const result = await importAgentFromPayload(
      makePayload({
        labels: [
          { key: "env", value: "staging" },
          { key: "team", value: "backend" },
        ],
        suggestedPrompts: [
          { summaryTitle: "Quick start", prompt: "Get me started" },
        ],
      }),
      user.id,
      org.id,
    );

    expect(result.agent.labels).toHaveLength(2);
    expect(result.agent.labels[0].key).toBe("env");
    expect(result.agent.labels[0].value).toBe("staging");
    expect(result.agent.suggestedPrompts).toHaveLength(1);
    expect(result.agent.suggestedPrompts[0].summaryTitle).toBe("Quick start");
  });

  test("roundtrip: export → import produces equivalent configuration", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    // Create an agent to export
    const original = await makeAgent({
      name: "Roundtrip Agent",
      organizationId: org.id,
      authorId: user.id,
      systemPrompt: "Be helpful",
      description: "A test agent",
    });

    // Export it
    const fullOriginal = await AgentModel.findById(original.id, user.id, true);
    expect(fullOriginal).not.toBeNull();
    if (!fullOriginal) throw new Error("fullOriginal should not be null");
    const exportedPayload = await serializeAgentForExport(fullOriginal);

    // Import it
    const importResult = await importAgentFromPayload(
      exportedPayload,
      user.id,
      org.id,
    );

    // The imported agent should have (imported) suffix since original exists
    expect(importResult.agent.name).toBe("Roundtrip Agent (imported)");
    expect(importResult.agent.agentType).toBe("agent");
    expect(importResult.agent.systemPrompt).toBe("Be helpful");
    expect(importResult.agent.description).toBe("A test agent");
    expect(importResult.agent.scope).toBe("personal");
    expect(importResult.warnings).toHaveLength(0);
  });

  test("pre-fills exclusions for an imported All-tools agent, keeping the payload's assigned built-ins reachable", async ({
    makeUser,
    makeOrganization,
  }) => {
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const org = await makeOrganization();
    const user = await makeUser();

    const assignedTool = await ToolModel.findByName(TOOL_LIST_AGENTS_FULL_NAME);
    expect(assignedTool).not.toBeNull();
    if (!assignedTool) throw new Error("list_agents tool not seeded");

    const result = await importAgentFromPayload(
      makePayload({
        agent: {
          ...makePayload().agent,
          accessAllTools: true,
          toolExposureMode: "search_and_run_only",
        },
        tools: [
          {
            toolName: TOOL_LIST_AGENTS_FULL_NAME,
            catalogName: null,
            credentialResolutionMode: "static",
          },
        ],
      }),
      user.id,
      org.id,
    );

    expect(result.warnings).toHaveLength(0);
    expect(result.agent.accessAllTools).toBe(true);

    // The payload's built-in tool is assigned AND not excluded.
    const assignedIds = await AgentToolModel.findToolIdsByAgent(
      result.agent.id,
    );
    expect(assignedIds).toContain(assignedTool.id);
    const excluded = new Set(
      await AgentExcludedToolModel.findToolIdsByAgent(result.agent.id),
    );
    expect(excluded.has(assignedTool.id)).toBe(false);

    // Other unassigned management built-ins are pre-excluded; the exempt
    // dispatch surface is not.
    const unassignedTool = await ToolModel.findByName(
      TOOL_CREATE_AGENT_FULL_NAME,
    );
    if (!unassignedTool) throw new Error("create_agent tool not seeded");
    expect(excluded.has(unassignedTool.id)).toBe(true);
    const searchTool = await ToolModel.findByName(TOOL_SEARCH_TOOLS_FULL_NAME);
    if (!searchTool) throw new Error("search_tools tool not seeded");
    expect(excluded.has(searchTool.id)).toBe(false);
  });
});

import {
  ARCHESTRA_MCP_CATALOG_ID,
  getArchestraToolFullName,
  TOOL_LIST_AGENTS_FULL_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_READ_FILE_FULL_NAME,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
  TOOL_WHOAMI_SHORT_NAME,
} from "@archestra/shared";
import config from "@/config";
import { KnowledgeBaseConnectorModel, ToolModel } from "@/models";
import McpServerUserModel from "@/models/mcp-server-user";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import { afterAll, beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import {
  getUnassignedDiscoverableTools,
  isDynamicallyAvailableArchestraTool,
  resolveDynamicTool,
  resolveDynamicToolByUiResource,
} from "./dynamic-tools";

const QUERY_KNOWLEDGE_SOURCES_FULL_NAME = getArchestraToolFullName(
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
);

// Dynamic tool access: with the agent's "access all tools" setting on, run_tool
// executes user-accessible tools directly (resolveDynamicTool) and unassigned
// built-ins become executable (isDynamicallyAvailableArchestraTool) — gated by
// feature flags, per-agent exclusions, and the query_knowledge_sources
// connector check. Nothing is written to the agent in any of these paths.

function makeTestConnector(params: {
  organizationId: string;
  visibility?: "org-wide" | "team-scoped";
  teamIds?: string[];
}) {
  return KnowledgeBaseConnectorModel.create({
    organizationId: params.organizationId,
    name: "Test Connector",
    connectorType: "jira",
    visibility: params.visibility ?? "org-wide",
    teamIds: params.teamIds ?? [],
    config: {
      type: "jira",
      jiraBaseUrl: "https://test.atlassian.net",
      isCloud: true,
      projectKey: "PROJ",
    },
  });
}

describe("resolveDynamicTool", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    userId = user.id;
    await makeMember(user.id, org.id, { role: "admin" });
    agent = await makeAgent({
      name: "Dynamic Agent",
      organizationId: org.id,
      accessAllTools: true,
    });
  });

  test("resolves an accessible catalog tool when the agent allows dynamic access", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });

    const tool = await resolveDynamicTool({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(tool?.name).toBe("github__search_repositories");
    expect(tool?.catalogId).toBe(catalog.id);
  });

  test("resolves for a user who cannot modify the agent (no agent mutation involved)", async ({
    makeCustomRole,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeTool,
    makeUser,
  }) => {
    const memberUser = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read"] },
    });
    await makeMember(memberUser.id, organizationId, { role: role.role });
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });

    const tool = await resolveDynamicTool({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId: memberUser.id,
      organizationId,
    });

    expect(tool?.name).toBe("github__search_repositories");
  });

  test("null when the agent's access-all-tools setting is off", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const strictAgent = await makeAgent({
      name: "Strict Agent",
      organizationId,
    });
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });

    const tool = await resolveDynamicTool({
      toolName: "github__search_repositories",
      agentId: strictAgent.id,
      userId,
      organizationId,
    });

    expect(tool).toBeNull();
  });

  test("null for sessions without a user (org/team tokens)", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });

    const tool = await resolveDynamicTool({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId: undefined,
      organizationId,
    });

    expect(tool).toBeNull();
  });

  test("null for the internal system user", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });

    const tool = await resolveDynamicTool({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId: "system",
      organizationId,
    });

    expect(tool).toBeNull();
  });

  test("null for a third-party row squatting a reserved archestra name", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    // Archestra built-ins are dispatched on the archestra route; a colliding
    // third-party row must not be executable through the dynamic path.
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: TOOL_RUN_COMMAND_FULL_NAME,
      catalogId: catalog.id,
    });

    const tool = await resolveDynamicTool({
      toolName: TOOL_RUN_COMMAND_FULL_NAME,
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(tool).toBeNull();
  });

  test("null for proxy-discovered agent__ rows", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({ name: "agent__leaked_artifact", catalogId: catalog.id });

    const tool = await resolveDynamicTool({
      toolName: "agent__leaked_artifact",
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(tool).toBeNull();
  });

  test("never writes an assignment to the agent", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });

    await resolveDynamicTool({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId,
      organizationId,
    });

    const assigned = await ToolModel.getAssignedToolNames(agent.id);
    expect(assigned.has("github__search_repositories")).toBe(false);
  });
});

describe("resolveDynamicToolByUiResource", () => {
  const RESOURCE_URI = "ui://excalidraw/mcp-app.html";
  let agent: Agent;
  let organizationId: string;
  let userId: string;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    userId = user.id;
    await makeMember(user.id, org.id, { role: "admin" });
    agent = await makeAgent({
      name: "Dynamic Agent",
      organizationId: org.id,
      accessAllTools: true,
    });
  });

  test("resolves each ui:// resource to its own tool, keyed on the exact resourceUri", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    // Two UI tools in the same catalog: resolving each URI must return that
    // tool, not the other. Asserting BOTH directions discriminates the exact
    // resourceUri match regardless of row ordering — if the filter ignored the
    // URI, both resolutions would return the same first-ordered row and one of
    // these assertions would fail.
    await makeTool({
      name: "excalidraw__other_view",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: "ui://excalidraw/other.html" } } },
    });
    await makeTool({
      name: "excalidraw__create_view",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: RESOURCE_URI } } },
    });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });

    const target = await resolveDynamicToolByUiResource({
      resourceUri: RESOURCE_URI,
      agentId: agent.id,
      userId,
      organizationId,
    });
    expect(target?.name).toBe("excalidraw__create_view");
    expect(target?.catalogId).toBe(catalog.id);

    const other = await resolveDynamicToolByUiResource({
      resourceUri: "ui://excalidraw/other.html",
      agentId: agent.id,
      userId,
      organizationId,
    });
    expect(other?.name).toBe("excalidraw__other_view");
  });

  test("null when the agent's access-all-tools setting is off", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const strictAgent = await makeAgent({
      name: "Strict Agent",
      organizationId,
    });
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "excalidraw__create_view",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: RESOURCE_URI } } },
    });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });

    const tool = await resolveDynamicToolByUiResource({
      resourceUri: RESOURCE_URI,
      agentId: strictAgent.id,
      userId,
      organizationId,
    });

    expect(tool).toBeNull();
  });

  test("null when the backing tool is not accessible to the user", async ({
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    // Another organization's catalog is not visible to the user, so its UI
    // tool must not resolve.
    const otherOrg = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({
      organizationId: otherOrg.id,
    });
    await makeTool({
      name: "excalidraw__create_view",
      catalogId: catalog.id,
      meta: { _meta: { ui: { resourceUri: RESOURCE_URI } } },
    });

    const tool = await resolveDynamicToolByUiResource({
      resourceUri: RESOURCE_URI,
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(tool).toBeNull();
  });

  test("null (fail closed) when the same ui:// resource is claimed by two accessible catalogs", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    // Two reachable catalogs both advertise the SAME ui:// URI. A resource read
    // carries only the URI, so the resolver cannot know which server ran the
    // tool — it must refuse rather than serve HTML from the wrong backend.
    const catalogA = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "excalidraw__create_view",
      catalogId: catalogA.id,
      meta: { _meta: { ui: { resourceUri: RESOURCE_URI } } },
    });
    await makeMcpServer({ catalogId: catalogA.id, scope: "org" });

    const catalogB = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "impostor__create_view",
      catalogId: catalogB.id,
      meta: { _meta: { ui: { resourceUri: RESOURCE_URI } } },
    });
    await makeMcpServer({ catalogId: catalogB.id, scope: "org" });

    const tool = await resolveDynamicToolByUiResource({
      resourceUri: RESOURCE_URI,
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(tool).toBeNull();
  });
});

describe("isDynamicallyAvailableArchestraTool", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    userId = user.id;
    await makeMember(user.id, org.id, { role: "admin" });
    agent = await makeAgent({
      name: "Dynamic Agent",
      organizationId: org.id,
      accessAllTools: true,
    });
  });

  describe("sandbox built-ins", () => {
    const originalSandboxEnabled = config.skillsSandbox.enabled;
    beforeEach(() => {
      (config.skillsSandbox as { enabled: boolean }).enabled = true;
    });
    afterAll(() => {
      (config.skillsSandbox as { enabled: boolean }).enabled =
        originalSandboxEnabled;
    });

    test("available when the sandbox feature is on and the gates pass", async () => {
      const available = await isDynamicallyAvailableArchestraTool({
        toolName: TOOL_RUN_COMMAND_FULL_NAME,
        agentId: agent.id,
        userId,
        organizationId,
      });

      expect(available).toBe(true);
    });

    test("unavailable when the agent's access-all-tools setting is off", async ({
      makeAgent,
    }) => {
      const strictAgent = await makeAgent({
        name: "Strict Agent",
        organizationId,
      });

      const available = await isDynamicallyAvailableArchestraTool({
        toolName: TOOL_RUN_COMMAND_FULL_NAME,
        agentId: strictAgent.id,
        userId,
        organizationId,
      });

      expect(available).toBe(false);
    });

    test("a persistent-files tool is available when the sandbox runtime is on", async () => {
      const available = await isDynamicallyAvailableArchestraTool({
        toolName: TOOL_READ_FILE_FULL_NAME,
        agentId: agent.id,
        userId,
        organizationId,
      });

      expect(available).toBe(true);
    });
  });

  test("sandbox built-in unavailable when the feature is off", async () => {
    const original = config.skillsSandbox.enabled;
    (config.skillsSandbox as { enabled: boolean }).enabled = false;
    try {
      const available = await isDynamicallyAvailableArchestraTool({
        toolName: TOOL_RUN_COMMAND_FULL_NAME,
        agentId: agent.id,
        userId,
        organizationId,
      });
      expect(available).toBe(false);
    } finally {
      (config.skillsSandbox as { enabled: boolean }).enabled = original;
    }
  });

  test("query_knowledge_sources available when the user can access a connector", async () => {
    await makeTestConnector({ organizationId });

    const available = await isDynamicallyAvailableArchestraTool({
      toolName: QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(available).toBe(true);
  });

  test("query_knowledge_sources unavailable when no connector exists", async () => {
    const available = await isDynamicallyAvailableArchestraTool({
      toolName: QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(available).toBe(false);
  });

  test("query_knowledge_sources unavailable when the only connector is scoped to another team", async ({
    makeCustomRole,
    makeMember,
    makeTeam,
    makeUser,
  }) => {
    const teamOwner = await makeUser();
    const team = await makeTeam(organizationId, teamOwner.id);
    await makeTestConnector({
      organizationId,
      visibility: "team-scoped",
      teamIds: [team.id],
    });
    // non-admin viewer outside the team (knowledgeSource admins see all)
    const outsider = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read"], knowledgeSource: ["query"] },
    });
    await makeMember(outsider.id, organizationId, { role: role.role });

    const available = await isDynamicallyAvailableArchestraTool({
      toolName: QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
      agentId: agent.id,
      userId: outsider.id,
      organizationId,
    });

    expect(available).toBe(false);
  });

  test("other archestra built-ins are dynamically available in All mode", async () => {
    // identity tool and a management tool — no feature gate, so the only
    // requirements are the dynamic-access context and no exclusion
    for (const toolName of [
      getArchestraToolFullName(TOOL_WHOAMI_SHORT_NAME),
      TOOL_LIST_AGENTS_FULL_NAME,
    ]) {
      const available = await isDynamicallyAvailableArchestraTool({
        toolName,
        agentId: agent.id,
        userId,
        organizationId,
      });
      expect(available).toBe(true);
    }
  });

  test("other archestra built-ins stay assignment-gated when access-all-tools is off", async ({
    makeAgent,
  }) => {
    const strictAgent = await makeAgent({
      name: "Strict Agent",
      organizationId,
    });

    const available = await isDynamicallyAvailableArchestraTool({
      toolName: getArchestraToolFullName(TOOL_WHOAMI_SHORT_NAME),
      agentId: strictAgent.id,
      userId,
      organizationId,
    });

    expect(available).toBe(false);
  });

  test("an excluded built-in is not dynamically available", async () => {
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const whoamiFullName = getArchestraToolFullName(TOOL_WHOAMI_SHORT_NAME);
    const whoami = await ToolModel.findByName(whoamiFullName);
    if (!whoami) throw new Error("whoami row missing");
    await agentToolExclusionsService.replaceExclusions({
      agentId: agent.id,
      organizationId,
      excludedToolIds: [whoami.id],
    });

    const available = await isDynamicallyAvailableArchestraTool({
      toolName: whoamiFullName,
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(available).toBe(false);
  });
});

describe("getUnassignedDiscoverableTools", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    userId = user.id;
    await makeMember(user.id, org.id, { role: "admin" });
    agent = await makeAgent({
      name: "Dynamic Agent",
      organizationId: org.id,
      accessAllTools: true,
    });
  });

  test("includes accessible catalog tools that are not assigned", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await makeTool({ name: "github__create_issue", catalogId: catalog.id });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });

    const tools = await getUnassignedDiscoverableTools({
      assignedToolNames: new Set(["github__create_issue"]),
      agentId: agent.id,
      userId,
      organizationId,
    });

    const names = tools.map((tool) => tool.name);
    expect(names).toContain("github__search_repositories");
    expect(names).not.toContain("github__create_issue");
  });

  test("empty when the agent's access-all-tools setting is off", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const strictAgent = await makeAgent({
      name: "Strict Agent",
      organizationId,
    });
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });

    const tools = await getUnassignedDiscoverableTools({
      assignedToolNames: new Set(),
      agentId: strictAgent.id,
      userId,
      organizationId,
    });

    expect(tools).toEqual([]);
  });

  test("includes query_knowledge_sources only when the user can access a connector", async () => {
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

    const withoutConnector = await getUnassignedDiscoverableTools({
      assignedToolNames: new Set(),
      agentId: agent.id,
      userId,
      organizationId,
    });
    expect(withoutConnector.map((tool) => tool.name)).not.toContain(
      QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
    );

    await makeTestConnector({ organizationId });

    const withConnector = await getUnassignedDiscoverableTools({
      assignedToolNames: new Set(),
      agentId: agent.id,
      userId,
      organizationId,
    });
    expect(withConnector.map((tool) => tool.name)).toContain(
      QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
    );
  });

  test("includes other archestra built-ins but never agent__ rows or the meta tools", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({ name: "agent__leaked_artifact", catalogId: catalog.id });

    const tools = await getUnassignedDiscoverableTools({
      assignedToolNames: new Set(),
      agentId: agent.id,
      userId,
      organizationId,
    });

    const names = tools.map((tool) => tool.name);
    // built-ins are discoverable in All mode
    expect(names).toContain(getArchestraToolFullName(TOOL_WHOAMI_SHORT_NAME));
    expect(names).toContain(TOOL_LIST_AGENTS_FULL_NAME);
    // proxy-discovered delegation artifacts stay out
    expect(names).not.toContain("agent__leaked_artifact");
    // the meta tools are the dispatch surface itself — never in this set
    expect(names).not.toContain(TOOL_SEARCH_TOOLS_FULL_NAME);
    expect(names).not.toContain(TOOL_RUN_TOOL_FULL_NAME);
  });
});

// Discovery follows catalog visibility, execution follows install access: an
// org-scoped catalog is visible (and therefore discoverable) to every member
// even when the member has no connection of their own yet — e.g. a per-user
// OAuth server the member has not signed in to. What stays install-scoped is
// execution: the call-time resolver only routes through installs the caller
// can access (own personal, team, or org — never another user's personal
// install) and otherwise returns the actionable auth-required setup prompt.
describe("dynamic discovery follows catalog visibility", () => {
  let agent: Agent;
  let organizationId: string;
  let userId: string;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    userId = user.id;
    await makeMember(user.id, org.id, { role: "admin" });
    agent = await makeAgent({
      name: "Dynamic Agent",
      organizationId: org.id,
      accessAllTools: true,
    });
  });

  // The caller has no connection yet, but the catalog is shared with them, so
  // they can set up their own — dropping the tool from discovery would hide
  // the call-time auth prompt that tells them to. Another user's connection
  // being the only install must not make the tool invisible.
  test("getUnassignedDiscoverableTools includes a tool whose only install is another user's personal server", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
    makeUser,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      scope: "org",
    });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    const otherUser = await makeUser();
    const otherInstall = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: otherUser.id,
    });
    await McpServerUserModel.assignUserToMcpServer(
      otherInstall.id,
      otherUser.id,
    );

    const tools = await getUnassignedDiscoverableTools({
      assignedToolNames: new Set(),
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(tools.map((tool) => tool.name)).toContain(
      "github__search_repositories",
    );
  });

  test("resolveDynamicTool resolves a tool whose only install is another user's personal server (auth is enforced at call time)", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
    makeUser,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      scope: "org",
    });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    const otherUser = await makeUser();
    const otherInstall = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: otherUser.id,
    });
    await McpServerUserModel.assignUserToMcpServer(
      otherInstall.id,
      otherUser.id,
    );

    const tool = await resolveDynamicTool({
      toolName: "github__search_repositories",
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("github__search_repositories");
  });

  test("getUnassignedDiscoverableTools includes a tool from a visible catalog with no install at all", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      scope: "org",
    });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });

    const tools = await getUnassignedDiscoverableTools({
      assignedToolNames: new Set(),
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(tools.map((tool) => tool.name)).toContain(
      "github__search_repositories",
    );
  });

  test("includes a tool the caller has their own personal install of", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      scope: "org",
    });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    const ownInstall = await makeMcpServer({
      catalogId: catalog.id,
      scope: "personal",
      ownerId: userId,
    });
    await McpServerUserModel.assignUserToMcpServer(ownInstall.id, userId);

    const tools = await getUnassignedDiscoverableTools({
      assignedToolNames: new Set(),
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(tools.map((tool) => tool.name)).toContain(
      "github__search_repositories",
    );
  });

  test("includes a tool backed by an org-scoped install", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      scope: "org",
    });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });

    const tools = await getUnassignedDiscoverableTools({
      assignedToolNames: new Set(),
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(tools.map((tool) => tool.name)).toContain(
      "github__search_repositories",
    );
  });

  test("includes a tool backed by an install for a team the caller belongs to", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTeam,
    makeTeamMember,
    makeTool,
  }) => {
    const team = await makeTeam(organizationId, userId);
    await makeTeamMember(team.id, userId);
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      scope: "org",
    });
    await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    await makeMcpServer({
      catalogId: catalog.id,
      scope: "team",
      teamId: team.id,
    });

    const tools = await getUnassignedDiscoverableTools({
      assignedToolNames: new Set(),
      agentId: agent.id,
      userId,
      organizationId,
    });

    expect(tools.map((tool) => tool.name)).toContain(
      "github__search_repositories",
    );
  });
});

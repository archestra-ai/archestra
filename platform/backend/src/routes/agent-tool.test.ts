import { ADMIN_ROLE_NAME } from "@shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { validateAssignment } from "@/services/agent-tool-assignment";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type {
  EnterpriseManagedCredentialConfig,
  InternalMcpCatalog,
  Tool,
  User,
} from "@/types";

/**
 * Build a minimal Tool object for test maps.
 * Only the fields checked by validateAssignment are set; the rest use defaults.
 */
function fakeTool(overrides: { id: string; catalogId?: string | null }): Tool {
  return {
    id: overrides.id,
    catalogId: overrides.catalogId ?? null,
    name: "test-tool",
    description: null,
    parameters: undefined,
    agentId: null,
    delegateToAgentId: null,
    meta: null,
    policiesAutoConfiguredAt: null,
    policiesAutoConfiguringStartedAt: null,
    policiesAutoConfiguredReasoning: null,
    policiesAutoConfiguredModel: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies Tool;
}

/**
 * Build a minimal InternalMcpCatalog for test maps.
 */
function fakeCatalog(overrides: {
  id: string;
  serverType: "local" | "remote";
}): InternalMcpCatalog {
  return {
    id: overrides.id,
    serverType: overrides.serverType,
  } as InternalMcpCatalog;
}

function emptyPreFetchedData() {
  return {
    existingAgentIds: new Set<string>(),
    toolsMap: new Map<string, Tool>(),
    catalogItemsMap: new Map<string, InternalMcpCatalog>(),
    mcpServersBasicMap: new Map<
      string,
      { id: string; ownerId: string | null; catalogId: string | null }
    >(),
  };
}

function _fakeEnterpriseManagedConfig(): EnterpriseManagedCredentialConfig {
  return {
    resourceIdentifier: "github-managed-connection",
    requestedCredentialType: "bearer_token",
  };
}

describe("validateAssignment", () => {
  test("returns null for a valid assignment with no catalog", async () => {
    const agentId = "agent-1";
    const tool = fakeTool({ id: "tool-1" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set([agentId]),
      toolsMap: new Map([[tool.id, tool]]),
    };

    const result = await validateAssignment({
      agentId,
      toolId: tool.id,
      mcpServerId: null,
      preFetchedData: data,
    });
    expect(result).toBeNull();
  });

  test("returns 404 when agent does not exist", async () => {
    const tool = fakeTool({ id: "tool-1" });

    const data = {
      ...emptyPreFetchedData(),
      toolsMap: new Map([[tool.id, tool]]),
    };

    const result = await validateAssignment({
      agentId: "missing-agent",
      toolId: tool.id,
      mcpServerId: null,
      preFetchedData: data,
    });
    expect(result).not.toBeNull();
    expect(result?.code).toBe("not_found");
    expect(result?.error.type).toBe("not_found");
    expect(result?.error.message).toContain("missing-agent");
  });

  test("returns 404 when tool does not exist", async () => {
    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: "missing-tool",
      mcpServerId: null,
      preFetchedData: data,
    });
    expect(result).not.toBeNull();
    expect(result?.code).toBe("not_found");
    expect(result?.error.type).toBe("not_found");
    expect(result?.error.message).toContain("missing-tool");
  });

  test("returns 400 for local server tool without execution source or late-bound credential resolution", async () => {
    const catalogId = "catalog-local";
    const tool = fakeTool({ id: "tool-1", catalogId });
    const catalog = fakeCatalog({ id: catalogId, serverType: "local" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
      catalogItemsMap: new Map([[catalogId, catalog]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      mcpServerId: null,
      preFetchedData: data,
    });
    expect(result).not.toBeNull();
    expect(result?.code).toBe("validation_error");
    expect(result?.error.message).toContain("MCP server installation");
  });

  test("allows local server tool with mcpServerId", async ({
    makeAgent,
    makeTool,
    makeMcpServer,
    makeInternalMcpCatalog,
  }) => {
    const catalogItem = await makeInternalMcpCatalog({
      serverType: "local",
    });
    const agent = await makeAgent();
    const tool = await makeTool({ catalogId: catalogItem.id });
    const server = await makeMcpServer({ catalogId: catalogItem.id });

    const data = {
      existingAgentIds: new Set([agent.id]),
      toolsMap: new Map([[tool.id, tool]]),
      catalogItemsMap: new Map([[catalogItem.id, catalogItem]]),
      mcpServersBasicMap: new Map([
        [
          server.id,
          { id: server.id, ownerId: null, catalogId: catalogItem.id },
        ],
      ]),
    };

    const result = await validateAssignment({
      agentId: agent.id,
      toolId: tool.id,
      mcpServerId: server.id,
      preFetchedData: data,
    });
    expect(result).toBeNull();
  });

  test("allows local server tool with resolveAtCallTime", async () => {
    const catalogId = "catalog-local";
    const tool = fakeTool({ id: "tool-1", catalogId });
    const catalog = fakeCatalog({ id: catalogId, serverType: "local" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
      catalogItemsMap: new Map([[catalogId, catalog]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      mcpServerId: null,
      preFetchedData: data,
      resolveAtCallTime: true,
    });
    expect(result).toBeNull();
  });

  test("allows local server tool with enterprise-managed credential resolution", async () => {
    const catalogId = "catalog-local";
    const tool = fakeTool({ id: "tool-1", catalogId });
    const catalog = fakeCatalog({ id: catalogId, serverType: "local" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
      catalogItemsMap: new Map([[catalogId, catalog]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      credentialResolutionMode: "enterprise_managed",
      mcpServerId: null,
      preFetchedData: data,
    });
    expect(result).toBeNull();
  });

  test("returns 400 for remote server tool without credential source or late-bound credential resolution", async () => {
    const catalogId = "catalog-remote";
    const tool = fakeTool({ id: "tool-1", catalogId });
    const catalog = fakeCatalog({ id: catalogId, serverType: "remote" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
      catalogItemsMap: new Map([[catalogId, catalog]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      mcpServerId: null,
      preFetchedData: data,
    });
    expect(result).not.toBeNull();
    expect(result?.code).toBe("validation_error");
    expect(result?.error.message).toContain("MCP server installation");
  });

  test("allows remote server tool with resolveAtCallTime", async () => {
    const catalogId = "catalog-remote";
    const tool = fakeTool({ id: "tool-1", catalogId });
    const catalog = fakeCatalog({ id: catalogId, serverType: "remote" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
      catalogItemsMap: new Map([[catalogId, catalog]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      mcpServerId: null,
      preFetchedData: data,
      resolveAtCallTime: true,
    });
    expect(result).toBeNull();
  });

  test("passes validation for tool with no catalogId (sniffed tool)", async () => {
    const tool = fakeTool({ id: "tool-1", catalogId: null });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      mcpServerId: null,
      preFetchedData: data,
    });
    expect(result).toBeNull();
  });

  test("passes validation when catalogId exists but catalog not in map", async () => {
    // catalogId set but catalog not found in pre-fetched map — no server type check
    const tool = fakeTool({ id: "tool-1", catalogId: "missing-catalog" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      mcpServerId: null,
      preFetchedData: data,
    });
    expect(result).toBeNull();
  });

  test("allows remote server tool with enterprise-managed credential resolution", async () => {
    const catalogId = "catalog-remote";
    const tool = fakeTool({ id: "tool-1", catalogId });
    const catalog = fakeCatalog({ id: catalogId, serverType: "remote" });

    const data = {
      ...emptyPreFetchedData(),
      existingAgentIds: new Set(["agent-1"]),
      toolsMap: new Map([[tool.id, tool]]),
      catalogItemsMap: new Map([[catalogId, catalog]]),
    };

    const result = await validateAssignment({
      agentId: "agent-1",
      toolId: tool.id,
      credentialResolutionMode: "enterprise_managed",
      mcpServerId: null,
      preFetchedData: data,
    });
    expect(result).toBeNull();
  });
});

describe("GET /api/agent-tools", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    user = await makeUser();
    const org = await makeOrganization();
    organizationId = org.id;

    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: agentToolRoutes } = await import("./agent-tool");
    await app.register(agentToolRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns paginated results by default", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const agent = await makeAgent({ organizationId });
    const tool = await makeTool();
    await makeAgentTool(agent.id, tool.id);

    const response = await app.inject({
      method: "GET",
      url: "/api/agent-tools?limit=5",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("pagination");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toHaveProperty("limit", 5);
    expect(body.pagination).toHaveProperty("total");
    expect(body.pagination).toHaveProperty("currentPage");
    expect(body.pagination).toHaveProperty("totalPages");
    expect(body.pagination).toHaveProperty("hasNext");
    expect(body.pagination).toHaveProperty("hasPrev");
  });

  test("filters by agentId", async ({ makeAgent, makeTool, makeAgentTool }) => {
    const agent1 = await makeAgent({ organizationId });
    const agent2 = await makeAgent({ organizationId });
    const tool1 = await makeTool();
    const tool2 = await makeTool();
    await makeAgentTool(agent1.id, tool1.id);
    await makeAgentTool(agent2.id, tool2.id);

    const response = await app.inject({
      method: "GET",
      url: `/api/agent-tools?agentId=${agent1.id}&limit=10`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("pagination");
    // All returned tools should belong to agent1
    for (const at of body.data) {
      expect(at.agent.id).toBe(agent1.id);
    }
    expect(body.pagination.limit).toBe(10);
  });

  test("skipPagination=true returns all results", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent({ organizationId });
    await seedAndAssignArchestraTools(agent.id);
    const tool = await makeTool();
    await makeAgentTool(agent.id, tool.id);

    const response = await app.inject({
      method: "GET",
      url: `/api/agent-tools?agentId=${agent.id}&skipPagination=true&limit=1`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("pagination");
    // Even with limit=1, skipPagination should return all tools
    expect(body.pagination.totalPages).toBe(1);
    expect(body.pagination.hasNext).toBe(false);
    expect(body.pagination.total).toBe(body.data.length);
    // Should have at least the non-archestra tool we created
    expect(body.data.length).toBeGreaterThan(0);
  });

  test("excludeArchestraTools filters out archestra tools", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent({ organizationId });
    await seedAndAssignArchestraTools(agent.id);
    const regularTool = await makeTool({ name: "regular-tool" });
    await makeAgentTool(agent.id, regularTool.id);

    const response = await app.inject({
      method: "GET",
      url: `/api/agent-tools?agentId=${agent.id}&skipPagination=true&excludeArchestraTools=true`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // No tools should have names starting with "archestra__"
    for (const at of body.data) {
      expect(at.tool.name.startsWith("archestra__")).toBe(false);
    }
    // Should still include the regular tool
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /api/agents/:agentId/tools/:toolId", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    adminUser = await makeUser();
    const org = await makeOrganization();
    organizationId = org.id;

    await makeMember(adminUser.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = adminUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: agentToolRoutes } = await import("./agent-tool");
    await app.register(agentToolRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("allows assigning a team-installed connection to a team-scoped agent in the same team", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTeam,
    makeTeamMember,
    makeTool,
  }) => {
    const sharedTeam = await makeTeam(organizationId, adminUser.id, {
      name: "Shared Team",
    });
    await makeTeamMember(sharedTeam.id, adminUser.id);

    const agent = await makeAgent({
      organizationId,
      authorId: adminUser.id,
      agentType: "agent",
      scope: "team",
      teams: [sharedTeam.id],
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "agent-tool",
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: adminUser.id,
      teamId: sharedTeam.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/tools/${tool.id}`,
      payload: { mcpServerId: mcpServer.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
  });

  test("allows assigning a team-installed connection to a team-scoped MCP gateway in the same team", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTeam,
    makeTeamMember,
    makeTool,
  }) => {
    const sharedTeam = await makeTeam(organizationId, adminUser.id, {
      name: "Shared Team",
    });
    await makeTeamMember(sharedTeam.id, adminUser.id);

    const agent = await makeAgent({
      organizationId,
      authorId: adminUser.id,
      agentType: "mcp_gateway",
      scope: "team",
      teams: [sharedTeam.id],
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "mcp_gateway-tool",
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: adminUser.id,
      teamId: sharedTeam.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/tools/${tool.id}`,
      payload: { mcpServerId: mcpServer.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
  });

  test("rejects assigning a team-installed connection to an agent in a different team", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTeam,
    makeTeamMember,
    makeTool,
  }) => {
    const gatewayTeam = await makeTeam(organizationId, adminUser.id, {
      name: "Gateway Team",
    });
    const otherTeam = await makeTeam(organizationId, adminUser.id, {
      name: "Other Team",
    });
    await makeTeamMember(gatewayTeam.id, adminUser.id);

    const agent = await makeAgent({
      organizationId,
      authorId: adminUser.id,
      agentType: "agent",
      scope: "team",
      teams: [gatewayTeam.id],
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "agent-tool",
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: adminUser.id,
      teamId: otherTeam.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/tools/${tool.id}`,
      payload: { mcpServerId: mcpServer.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message: "This team connection is not shared with the selected team",
      },
    });
  });

  test("rejects assigning a team-installed connection to an MCP gateway in a different team", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTeam,
    makeTeamMember,
    makeTool,
  }) => {
    const gatewayTeam = await makeTeam(organizationId, adminUser.id, {
      name: "Gateway Team",
    });
    const otherTeam = await makeTeam(organizationId, adminUser.id, {
      name: "Other Team",
    });
    await makeTeamMember(gatewayTeam.id, adminUser.id);

    const agent = await makeAgent({
      organizationId,
      authorId: adminUser.id,
      agentType: "mcp_gateway",
      scope: "team",
      teams: [gatewayTeam.id],
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "mcp_gateway-tool",
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: adminUser.id,
      teamId: otherTeam.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/tools/${tool.id}`,
      payload: { mcpServerId: mcpServer.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message: "This team connection is not shared with the selected team",
      },
    });
  });

  test("rejects assigning a personal connection to an org-scoped agent", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: adminUser.id,
      agentType: "agent",
      scope: "org",
      teams: [],
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "org-agent-tool",
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: adminUser.id,
      teamId: null,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/tools/${tool.id}`,
      payload: { mcpServerId: mcpServer.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message: "Personal connections can only be assigned to personal agents",
      },
    });
  });

  test("rejects assigning a personal connection to a team-scoped agent", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTeam,
    makeTeamMember,
    makeTool,
  }) => {
    const sharedTeam = await makeTeam(organizationId, adminUser.id, {
      name: "Shared Team",
    });
    await makeTeamMember(sharedTeam.id, adminUser.id);

    const agent = await makeAgent({
      organizationId,
      authorId: adminUser.id,
      agentType: "agent",
      scope: "team",
      teams: [sharedTeam.id],
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "team-agent-tool",
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: adminUser.id,
      teamId: null,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/tools/${tool.id}`,
      payload: { mcpServerId: mcpServer.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message: "Personal connections can only be assigned to personal agents",
      },
    });
  });

  test("rejects assigning a personal connection to a team-scoped MCP gateway", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTeam,
    makeTeamMember,
    makeTool,
  }) => {
    const sharedTeam = await makeTeam(organizationId, adminUser.id, {
      name: "Shared Team",
    });
    await makeTeamMember(sharedTeam.id, adminUser.id);

    const gateway = await makeAgent({
      organizationId,
      authorId: adminUser.id,
      agentType: "mcp_gateway",
      scope: "team",
      teams: [sharedTeam.id],
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "team-gateway-tool",
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: adminUser.id,
      teamId: null,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${gateway.id}/tools/${tool.id}`,
      payload: { mcpServerId: mcpServer.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message: "Personal connections can only be assigned to personal agents",
      },
    });
  });
});

describe("GET /api/agents/:agentId/tools", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    user = await makeUser();
    const org = await makeOrganization();
    organizationId = org.id;

    await makeMember(user.id, organizationId);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: agentToolRoutes } = await import("./agent-tool");
    await app.register(agentToolRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("allows a team member to read tools for a team-scoped agent in their team", async ({
    makeAgent,
    makeAgentTool,
    makeMcpServer,
    makeTeam,
    makeTeamMember,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    const sharedTeam = await makeTeam(organizationId, user.id, {
      name: "Shared Team",
    });
    await makeTeamMember(sharedTeam.id, user.id);
    const agent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "team",
      teams: [sharedTeam.id],
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({ name: "agent-tool", catalogId: catalog.id });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: sharedTeam.id,
    });
    await makeAgentTool(agent.id, tool.id, {
      mcpServerId: mcpServer.id,
      credentialResolutionMode: "static",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/tools`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: tool.id,
          mcpServerId: mcpServer.id,
          credentialResolutionMode: "static",
        }),
      ]),
    );
  });

  test("allows a team member to read tools for a team-scoped MCP gateway in their team", async ({
    makeAgent,
    makeAgentTool,
    makeMcpServer,
    makeTeam,
    makeTeamMember,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    const sharedTeam = await makeTeam(organizationId, user.id, {
      name: "Shared Team",
    });
    await makeTeamMember(sharedTeam.id, user.id);
    const gateway = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "mcp_gateway",
      scope: "team",
      teams: [sharedTeam.id],
    });
    const catalog = await makeInternalMcpCatalog({ serverType: "remote" });
    const tool = await makeTool({
      name: "gateway-tool",
      catalogId: catalog.id,
    });
    const mcpServer = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: sharedTeam.id,
    });
    await makeAgentTool(gateway.id, tool.id, {
      mcpServerId: mcpServer.id,
      credentialResolutionMode: "static",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${gateway.id}/tools`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: tool.id,
          mcpServerId: mcpServer.id,
          credentialResolutionMode: "static",
        }),
      ]),
    );
  });
});

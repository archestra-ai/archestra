import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AgentModel, AgentToolModel, AgentVersionModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import {
  type PrefetchedMcpServer,
  validateAssignment,
} from "@/services/agent-tool-assignment";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { InternalMcpCatalog, Tool, User } from "@/types";
import { MAX_BULK_AGENT_TOOL_ENTRIES } from "@/types";

/**
 * Build a minimal Tool object for test maps.
 * Only the fields checked by validateAssignment are set; the rest use defaults.
 */
function fakeTool(overrides: { id: string; catalogId?: string | null }): Tool {
  return {
    id: overrides.id,
    catalogId: overrides.catalogId ?? null,
    name: "test-tool",
    rawName: null,
    description: null,
    parameters: undefined,
    agentId: null,
    delegateToAgentId: null,
    meta: null,
    clonedPendingDiscovery: false,
    policiesAutoConfiguredAt: null,
    policiesAutoConfiguringStartedAt: null,
    policiesAutoConfiguredReasoning: null,
    policiesAutoConfiguredModel: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
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
    mcpServersBasicMap: new Map<string, PrefetchedMcpServer>(),
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

  test("allows shared local server tool with mcpServerId", async ({
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
    const server = await makeMcpServer({
      catalogId: catalogItem.id,
      scope: "org",
    });

    const data = {
      existingAgentIds: new Set([agent.id]),
      toolsMap: new Map([[tool.id, tool]]),
      catalogItemsMap: new Map([[catalogItem.id, catalogItem]]),
      mcpServersBasicMap: new Map<string, PrefetchedMcpServer>([
        [
          server.id,
          {
            id: server.id,
            ownerId: null,
            catalogId: catalogItem.id,
            scope: server.scope,
          },
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
      scope: "team",
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
      scope: "team",
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
      scope: "team",
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
      scope: "team",
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

  test("rejects a personal connection for an org-scoped agent", async ({
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
    expect(response.json().error.message).toContain(
      "dynamic credential resolution",
    );
  });

  test("rejects a personal connection for a team-scoped agent", async ({
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
    expect(response.json().error.message).toContain(
      "dynamic credential resolution",
    );
  });

  test("rejects a personal connection for a team-scoped MCP gateway", async ({
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
    expect(response.json().error.message).toContain(
      "dynamic credential resolution",
    );
  });
});

describe("POST /api/agents/tools/bulk-assign", () => {
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

  test("infers enterprise-managed credential resolution for legacy late-bound assignments", async ({
    makeAgent,
    makeIdentityProvider,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const identityProvider = await makeIdentityProvider(adminUser.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "remote",
      enterpriseManagedConfig: {
        identityProviderId: identityProvider.id,
        requestedCredentialType: "bearer_token",
        tokenInjectionMode: "authorization_bearer",
      },
    });
    const agent = await makeAgent({
      organizationId,
      authorId: adminUser.id,
    });
    const tool = await makeTool({ catalogId: catalog.id });

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/tools/bulk-assign",
      payload: {
        assignments: [
          {
            agentId: agent.id,
            toolId: tool.id,
            resolveAtCallTime: true,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      succeeded: [{ agentId: agent.id, toolId: tool.id }],
      failed: [],
    });

    const [assignment] = await db
      .select({
        credentialResolutionMode:
          schema.agentToolsTable.credentialResolutionMode,
      })
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );

    expect(assignment?.credentialResolutionMode).toBe("enterprise_managed");
  });

  // Shares the tenant fence with bulk-update: the scope checks cannot catch a
  // foreign tenant on their own, because they short-circuit for an admin and
  // "admin" means admin of the CALLER's organization.
  test("does not assign to an agent belonging to another organization", async ({
    makeAgent,
    makeOrganization,
    makeTool,
  }) => {
    const otherOrg = await makeOrganization();
    const foreignAgent = await makeAgent({ organizationId: otherOrg.id });
    const tool = await makeTool();

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/tools/bulk-assign",
      payload: {
        assignments: [{ agentId: foreignAgent.id, toolId: tool.id }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Indistinguishable from an agent that does not exist.
    expect(body.succeeded).toEqual([]);
    expect(body.failed).toEqual([
      {
        agentId: foreignAgent.id,
        toolId: tool.id,
        error: `Agent with ID ${foreignAgent.id} not found`,
      },
    ]);
    expect(await AgentToolModel.findToolIdsByAgent(foreignAgent.id)).toEqual(
      [],
    );
  });
});

describe("POST /api/agents/tools/bulk-update", () => {
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

    registerAuditLogHook(app);

    const { default: agentToolRoutes } = await import("./agent-tool");
    await app.register(agentToolRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("applies additions and removals for several agents in one request", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const agentA = await makeAgent({ organizationId, authorId: adminUser.id });
    const agentB = await makeAgent({ organizationId, authorId: adminUser.id });
    const [keep, add, drop] = await Promise.all([
      makeTool(),
      makeTool(),
      makeTool(),
    ]);
    await makeAgentTool(agentA.id, keep.id);
    await makeAgentTool(agentA.id, drop.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/tools/bulk-update",
      payload: {
        assignments: [
          { agentId: agentA.id, toolId: add.id },
          { agentId: agentB.id, toolId: add.id },
        ],
        removals: [{ agentId: agentA.id, toolId: drop.id }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.failed).toEqual([]);
    expect(body.succeeded).toEqual(
      expect.arrayContaining([
        { agentId: agentA.id, toolId: add.id },
        { agentId: agentB.id, toolId: add.id },
      ]),
    );
    expect(body.removed).toEqual([{ agentId: agentA.id, toolId: drop.id }]);

    const agentAToolIds = await AgentToolModel.findToolIdsByAgent(agentA.id);
    expect(agentAToolIds.sort()).toEqual([add.id, keep.id].sort());
    expect(await AgentToolModel.findToolIdsByAgent(agentB.id)).toEqual([
      add.id,
    ]);
  });

  // The whole point of the batch: one save is one version, not one per tool.
  test("forks exactly one config version per agent regardless of tool count", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: adminUser.id });
    const versionBefore = (await AgentModel.findById(agent.id))?.latestVersion;

    const toAdd = await Promise.all([makeTool(), makeTool(), makeTool()]);
    const toDrop = await Promise.all([makeTool(), makeTool()]);
    for (const tool of toDrop) {
      await makeAgentTool(agent.id, tool.id);
    }
    // Assigning directly through the model does not fork, so the count below
    // measures only what the route did.
    const versionBeforeRoute = (await AgentModel.findById(agent.id))
      ?.latestVersion;
    expect(versionBeforeRoute).toBe(versionBefore);

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/tools/bulk-update",
      payload: {
        assignments: toAdd.map((tool) => ({
          agentId: agent.id,
          toolId: tool.id,
        })),
        removals: toDrop.map((tool) => ({
          agentId: agent.id,
          toolId: tool.id,
        })),
      },
    });

    expect(response.statusCode).toBe(200);
    expect((await AgentModel.findById(agent.id))?.latestVersion).toBe(
      (versionBefore ?? 0) + 1,
    );
  });

  // Regression guard: keying the fork off assignment results alone would record
  // no version at all for a save that only removes tools.
  test("forks a version for a removals-only save", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: adminUser.id });
    const tool = await makeTool();
    await makeAgentTool(agent.id, tool.id);
    // Capture the assignment in the head snapshot. Without this the removal
    // restores the config the agent was created with, and content-hash dedup
    // correctly suppresses the fork — which would test nothing.
    await AgentVersionModel.forkIfChanged(agent.id);
    const versionBefore = (await AgentModel.findById(agent.id))?.latestVersion;

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/tools/bulk-update",
      payload: {
        assignments: [],
        removals: [{ agentId: agent.id, toolId: tool.id }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().removed).toEqual([
      { agentId: agent.id, toolId: tool.id },
    ]);
    expect((await AgentModel.findById(agent.id))?.latestVersion).toBe(
      (versionBefore ?? 0) + 1,
    );
  });

  // `notAssigned` is the removal-side twin of `duplicates`: a client working
  // from a stale view must not see a no-op reported as a failed save. It means
  // exactly one thing — the agent was reachable and the row was already gone.
  // An unreachable agent is a `failed` (see the cross-organization test below).
  test("reports an already-unassigned tool as notAssigned, not failed", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: adminUser.id });
    const tool = await makeTool();

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/tools/bulk-update",
      payload: {
        assignments: [],
        removals: [{ agentId: agent.id, toolId: tool.id }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.failed).toEqual([]);
    expect(body.removed).toEqual([]);
    expect(body.notAssigned).toEqual([{ agentId: agent.id, toolId: tool.id }]);
  });

  test("re-assigning a tool with a changed credential mode reports it as succeeded", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: adminUser.id });
    const tool = await makeTool();
    await makeAgentTool(agent.id, tool.id, {
      credentialResolutionMode: "static",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/tools/bulk-update",
      payload: {
        assignments: [
          {
            agentId: agent.id,
            toolId: tool.id,
            credentialResolutionMode: "dynamic",
          },
        ],
        removals: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toEqual([
      { agentId: agent.id, toolId: tool.id },
    ]);

    const [assignment] = await db
      .select({
        credentialResolutionMode:
          schema.agentToolsTable.credentialResolutionMode,
      })
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );
    expect(assignment?.credentialResolutionMode).toBe("dynamic");
  });

  // Agent ids come straight from the body, and the scope checks cannot catch a
  // foreign tenant: they short-circuit for an admin, and "admin" means admin of
  // the CALLER's organization.
  test("does not touch an agent belonging to another organization", async ({
    makeAgent,
    makeOrganization,
    makeTool,
    makeAgentTool,
  }) => {
    const otherOrg = await makeOrganization();
    const foreignAgent = await makeAgent({ organizationId: otherOrg.id });
    const [existing, added] = await Promise.all([makeTool(), makeTool()]);
    await makeAgentTool(foreignAgent.id, existing.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/tools/bulk-update",
      payload: {
        assignments: [{ agentId: foreignAgent.id, toolId: added.id }],
        removals: [{ agentId: foreignAgent.id, toolId: existing.id }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The agent is indistinguishable from one that does not exist.
    expect(body.succeeded).toEqual([]);
    expect(body.removed).toEqual([]);
    // BOTH halves report it, and identically. A removal aimed at an
    // unreachable agent applied nothing, so reporting it as `notAssigned`
    // would tell the client to ignore a save that silently did nothing.
    expect(body.notAssigned).toEqual([]);
    expect(body.failed).toEqual(
      expect.arrayContaining([
        {
          agentId: foreignAgent.id,
          toolId: added.id,
          error: `Agent with ID ${foreignAgent.id} not found`,
        },
        {
          agentId: foreignAgent.id,
          toolId: existing.id,
          error: `Agent with ID ${foreignAgent.id} not found`,
        },
      ]),
    );
    expect(body.failed).toHaveLength(2);
    expect(await AgentToolModel.findToolIdsByAgent(foreignAgent.id)).toEqual([
      existing.id,
    ]);
  });

  // Removals are written before assignments. Without a transaction a throw in
  // the assignment write leaves them committed but unforked: the agent has
  // silently lost tools and no config version records the state to restore.
  test("rolls the removals back when the assignment write fails", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: adminUser.id });
    const [drop, add] = await Promise.all([makeTool(), makeTool()]);
    await makeAgentTool(agent.id, drop.id);
    await AgentVersionModel.forkIfChanged(agent.id);
    const versionBefore = (await AgentModel.findById(agent.id))?.latestVersion;

    const spy = vi
      .spyOn(AgentToolModel, "bulkCreateOrUpdateCredentials")
      .mockRejectedValueOnce(new Error("assignment write blew up"));

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agents/tools/bulk-update",
        payload: {
          assignments: [{ agentId: agent.id, toolId: add.id }],
          removals: [{ agentId: agent.id, toolId: drop.id }],
        },
      });

      expect(response.statusCode).toBe(500);
      // Nothing was applied, so nothing is reported as removed. The result
      // arrays are built inside the transaction callback precisely so a rollback
      // cannot leave a removal report behind for a delete that was undone.
      expect(response.json().removed).toBeUndefined();
      expect(response.json().notAssigned).toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    // The removal is undone, so the agent's tool surface is exactly what it was
    // and the version history still describes it.
    expect(await AgentToolModel.findToolIdsByAgent(agent.id)).toEqual([
      drop.id,
    ]);
    expect((await AgentModel.findById(agent.id))?.latestVersion).toBe(
      versionBefore,
    );
  });

  // Contradictory input: the same pair in both lists. Before the removal was
  // filtered out, the row was deleted and re-inserted and the pair came back in
  // BOTH `removed` and `succeeded` — two outcomes a client reconciling against
  // the response cannot both act on.
  test("lets the assignment win when a pair appears in both lists", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: adminUser.id });
    const tool = await makeTool();
    // Already assigned statically, so the assignment below is a real change and
    // lands in `succeeded` rather than `duplicates`.
    const original = await makeAgentTool(agent.id, tool.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/tools/bulk-update",
      payload: {
        assignments: [
          {
            agentId: agent.id,
            toolId: tool.id,
            credentialResolutionMode: "dynamic",
          },
        ],
        removals: [{ agentId: agent.id, toolId: tool.id }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.failed).toEqual([]);
    expect(body.succeeded).toEqual([{ agentId: agent.id, toolId: tool.id }]);
    expect(body.removed).toEqual([]);
    expect(body.notAssigned).toEqual([]);

    // Updated in place rather than deleted and re-created: same row, so an
    // audit trail keyed on the assignment id still follows it.
    const rows = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(original.id);
    expect(rows[0].credentialResolutionMode).toBe("dynamic");
  });

  // The same contradictory input, but the assignment fails validation. The
  // removal must still be dropped: a client re-pinning a tool to a server that
  // vanished asked to change the pin, not to lose the tool. Reporting the pair
  // in both `failed` and `removed` would also contradict the endpoint's promise
  // that an assignment shields its paired removal.
  test("keeps the row when a pair appears in both lists and the assignment fails", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: adminUser.id });
    const tool = await makeTool();
    const original = await makeAgentTool(agent.id, tool.id);
    const missingServerId = "00000000-0000-4000-8000-000000000001";

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/tools/bulk-update",
      payload: {
        assignments: [
          {
            agentId: agent.id,
            toolId: tool.id,
            mcpServerId: missingServerId,
          },
        ],
        removals: [{ agentId: agent.id, toolId: tool.id }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]).toMatchObject({
      agentId: agent.id,
      toolId: tool.id,
    });
    expect(body.succeeded).toEqual([]);
    expect(body.removed).toEqual([]);
    expect(body.notAssigned).toEqual([]);

    // The pre-existing assignment is untouched — same row, same pin.
    const rows = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(original.id);
    expect(rows[0].mcpServerId).toBe(original.mcpServerId);
  });

  test("rejects a body over the entry ceiling", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: adminUser.id });
    const tool = await makeTool();

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/tools/bulk-update",
      payload: {
        assignments: Array.from(
          { length: MAX_BULK_AGENT_TOOL_ENTRIES + 1 },
          () => ({ agentId: agent.id, toolId: tool.id }),
        ),
        removals: [],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  // The ceiling is per body, not per list: two arrays each just under it would
  // otherwise carry twice the work the cap is meant to bound.
  test("rejects a body over the entry ceiling across both lists", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: adminUser.id });
    const tool = await makeTool();
    const half = Math.ceil(MAX_BULK_AGENT_TOOL_ENTRIES / 2) + 1;

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/tools/bulk-update",
      payload: {
        assignments: Array.from({ length: half }, () => ({
          agentId: agent.id,
          toolId: tool.id,
        })),
        removals: Array.from({ length: half }, () => ({
          agentId: agent.id,
          toolId: tool.id,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("writes an audit record naming the affected agents and their assignments", async ({
    makeAgent,
    makeTool,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: adminUser.id });
    const tool = await makeTool();

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/tools/bulk-update",
      payload: {
        assignments: [{ agentId: agent.id, toolId: tool.id }],
        removals: [],
      },
    });
    expect(response.statusCode).toBe(200);
    // The audit row is written fire-and-forget from the onResponse hook.
    await new Promise((r) => setTimeout(r, 50));

    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "agentTool",
      limit: 20,
      offset: 0,
    });
    const row = data.find((r) => r.action === "agentTool.bulk_updated");

    expect(row?.outcome).toBe("success");
    // A per-agent snapshot, not the org-wide assignment count: the diff has to
    // say WHICH agent got WHICH tool.
    expect(row?.before).not.toBeNull();
    expect(row?.after).not.toBeNull();
    expect(row?.before).not.toEqual(row?.after);
    expect(
      (row?.after as { agents?: Record<string, unknown[]> } | null)?.agents?.[
        agent.id
      ],
    ).toEqual([
      expect.objectContaining({
        toolId: tool.id,
        credentialResolutionMode: "static",
      }),
    ]);
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
      scope: "team",
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
      scope: "team",
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

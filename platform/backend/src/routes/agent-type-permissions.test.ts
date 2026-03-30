import { ADMIN_ROLE_NAME, BUILT_IN_AGENT_IDS } from "@shared";
import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/observability", () => ({
  metrics: {
    llm: { initializeMetrics: vi.fn() },
    mcp: { initializeMcpMetrics: vi.fn() },
    agentExecution: { initializeAgentExecutionMetrics: vi.fn() },
  },
}));

/**
 * Route-level integration tests for agent-type permission isolation.
 *
 * Verifies that the 3-resource RBAC split (agent, mcpGateway, llmProxy)
 * correctly enforces access control at the HTTP route level. A user with
 * permissions on one resource should NOT be able to access the other two.
 *
 * Also verifies scope-based access: members can only CRUD personal agents,
 * team-admins can manage team-scoped agents, and admins can manage all scopes.
 */
describe("agent type permission isolation (routes)", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let memberUser: User;
  let organizationId: string;

  /**
   * Swap the onRequest hook to impersonate a different user.
   * Returns a new Fastify instance with routes registered.
   */
  async function createAppForUser(user: User) {
    const instance = createFastifyInstance();
    instance.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: agentRoutes } = await import("./agent");
    const { default: userRoutes } = await import("./user");
    await instance.register(agentRoutes);
    await instance.register(userRoutes);
    return instance;
  }

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    adminUser = await makeUser();
    memberUser = await makeUser();
    const org = await makeOrganization();
    organizationId = org.id;

    await makeMember(adminUser.id, organizationId, { role: ADMIN_ROLE_NAME });
    // memberUser role is set per test via custom roles

    app = await createAppForUser(adminUser);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("single-resource isolation", () => {
    test("user with only mcpGateway perms can list gateways but not agents or proxies", async ({
      makeCustomRole,
      makeMember,
    }) => {
      await makeCustomRole(organizationId, {
        role: "gw_only",
        permission: { mcpGateway: ["read", "create", "update", "delete"] },
      });
      await makeMember(memberUser.id, organizationId, { role: "gw_only" });
      const memberApp = await createAppForUser(memberUser);

      try {
        // Can list MCP gateways
        const gwRes = await memberApp.inject({
          method: "GET",
          url: "/api/agents?agentType=mcp_gateway",
        });
        expect(gwRes.statusCode).toBe(200);

        // Forbidden from listing agents
        const agentRes = await memberApp.inject({
          method: "GET",
          url: "/api/agents?agentType=agent",
        });
        expect(agentRes.statusCode).toBe(403);

        // Forbidden from listing LLM proxies
        const proxyRes = await memberApp.inject({
          method: "GET",
          url: "/api/agents?agentType=llm_proxy",
        });
        expect(proxyRes.statusCode).toBe(403);

        // Can create a personal MCP gateway
        const createGwRes = await memberApp.inject({
          method: "POST",
          url: "/api/agents",
          payload: {
            name: "test-gw",
            agentType: "mcp_gateway",
            scope: "personal",
            teams: [],
            labels: [],
            knowledgeBaseIds: [],
            connectorIds: [],
          },
        });
        expect(createGwRes.statusCode).toBe(200);

        // Forbidden from creating an agent
        const createAgentRes = await memberApp.inject({
          method: "POST",
          url: "/api/agents",
          payload: {
            name: "test-agent",
            agentType: "agent",
            scope: "personal",
            teams: [],
            labels: [],
            knowledgeBaseIds: [],
            connectorIds: [],
          },
        });
        expect(createAgentRes.statusCode).toBe(403);

        // Forbidden from creating an LLM proxy
        const createProxyRes = await memberApp.inject({
          method: "POST",
          url: "/api/agents",
          payload: {
            name: "test-proxy",
            agentType: "llm_proxy",
            scope: "personal",
            teams: [],
            labels: [],
            knowledgeBaseIds: [],
            connectorIds: [],
          },
        });
        expect(createProxyRes.statusCode).toBe(403);
      } finally {
        await memberApp.close();
      }
    });

    test("user with only llmProxy perms can list proxies but not agents or gateways", async ({
      makeCustomRole,
      makeMember,
    }) => {
      await makeCustomRole(organizationId, {
        role: "proxy_only",
        permission: { llmProxy: ["read", "create", "update", "delete"] },
      });
      await makeMember(memberUser.id, organizationId, { role: "proxy_only" });
      const memberApp = await createAppForUser(memberUser);

      try {
        const proxyRes = await memberApp.inject({
          method: "GET",
          url: "/api/agents?agentType=llm_proxy",
        });
        expect(proxyRes.statusCode).toBe(200);

        const agentRes = await memberApp.inject({
          method: "GET",
          url: "/api/agents?agentType=agent",
        });
        expect(agentRes.statusCode).toBe(403);

        const gwRes = await memberApp.inject({
          method: "GET",
          url: "/api/agents?agentType=mcp_gateway",
        });
        expect(gwRes.statusCode).toBe(403);

        // Can create a personal LLM proxy
        const createRes = await memberApp.inject({
          method: "POST",
          url: "/api/agents",
          payload: {
            name: "test-proxy",
            agentType: "llm_proxy",
            scope: "personal",
            teams: [],
            labels: [],
            knowledgeBaseIds: [],
            connectorIds: [],
          },
        });
        expect(createRes.statusCode).toBe(200);
      } finally {
        await memberApp.close();
      }
    });

    test("user with only agent perms can list agents but not gateways or proxies", async ({
      makeCustomRole,
      makeMember,
    }) => {
      await makeCustomRole(organizationId, {
        role: "agent_only",
        permission: { agent: ["read", "create", "update", "delete"] },
      });
      await makeMember(memberUser.id, organizationId, { role: "agent_only" });
      const memberApp = await createAppForUser(memberUser);

      try {
        const agentRes = await memberApp.inject({
          method: "GET",
          url: "/api/agents?agentType=agent",
        });
        expect(agentRes.statusCode).toBe(200);

        const gwRes = await memberApp.inject({
          method: "GET",
          url: "/api/agents?agentType=mcp_gateway",
        });
        expect(gwRes.statusCode).toBe(403);

        const proxyRes = await memberApp.inject({
          method: "GET",
          url: "/api/agents?agentType=llm_proxy",
        });
        expect(proxyRes.statusCode).toBe(403);
      } finally {
        await memberApp.close();
      }
    });
  });

  describe("mixed permissions", () => {
    test("user with agent+mcpGateway but not llmProxy can access allowed types only", async ({
      makeCustomRole,
      makeMember,
    }) => {
      await makeCustomRole(organizationId, {
        role: "agent_gw",
        permission: {
          agent: ["read", "create"],
          mcpGateway: ["read", "create"],
        },
      });
      await makeMember(memberUser.id, organizationId, { role: "agent_gw" });
      const memberApp = await createAppForUser(memberUser);

      try {
        const agentRes = await memberApp.inject({
          method: "GET",
          url: "/api/agents?agentType=agent",
        });
        expect(agentRes.statusCode).toBe(200);

        const gwRes = await memberApp.inject({
          method: "GET",
          url: "/api/agents?agentType=mcp_gateway",
        });
        expect(gwRes.statusCode).toBe(200);

        const proxyRes = await memberApp.inject({
          method: "GET",
          url: "/api/agents?agentType=llm_proxy",
        });
        expect(proxyRes.statusCode).toBe(403);
      } finally {
        await memberApp.close();
      }
    });
  });

  describe("individual agent CRUD isolation", () => {
    test("user can GET/PUT/DELETE agents of allowed type but not disallowed type", async ({
      makeCustomRole,
      makeMember,
      makeAgent,
    }) => {
      // Create agents as admin (org-scoped so visible to admin-type users)
      const proxy = await makeAgent({
        organizationId,
        agentType: "llm_proxy",
        scope: "org",
        authorId: adminUser.id,
      });
      const gateway = await makeAgent({
        organizationId,
        agentType: "mcp_gateway",
        scope: "org",
        authorId: adminUser.id,
      });

      // Give member only mcpGateway CRUD + admin (so they can modify org-scope)
      await makeCustomRole(organizationId, {
        role: "gw_crud",
        permission: {
          mcpGateway: ["read", "create", "update", "delete", "admin"],
        },
      });
      await makeMember(memberUser.id, organizationId, { role: "gw_crud" });
      const memberApp = await createAppForUser(memberUser);

      try {
        // CAN get the MCP gateway
        const getGwRes = await memberApp.inject({
          method: "GET",
          url: `/api/agents/${gateway.id}`,
        });
        expect(getGwRes.statusCode).toBe(200);

        // CANNOT get the LLM proxy (returns 404 to avoid leaking existence)
        const getProxyRes = await memberApp.inject({
          method: "GET",
          url: `/api/agents/${proxy.id}`,
        });
        expect(getProxyRes.statusCode).toBe(404);

        // CAN update the MCP gateway
        const updateGwRes = await memberApp.inject({
          method: "PUT",
          url: `/api/agents/${gateway.id}`,
          payload: { name: "updated-gw" },
        });
        expect(updateGwRes.statusCode).toBe(200);

        // CANNOT update the LLM proxy
        const updateProxyRes = await memberApp.inject({
          method: "PUT",
          url: `/api/agents/${proxy.id}`,
          payload: { name: "updated-proxy" },
        });
        expect(updateProxyRes.statusCode).toBe(404);

        // CANNOT delete the LLM proxy
        const deleteProxyRes = await memberApp.inject({
          method: "DELETE",
          url: `/api/agents/${proxy.id}`,
        });
        expect(deleteProxyRes.statusCode).toBe(404);

        // CAN delete the MCP gateway
        const deleteGwRes = await memberApp.inject({
          method: "DELETE",
          url: `/api/agents/${gateway.id}`,
        });
        if (deleteGwRes.statusCode !== 200) {
          // Debug: verify the gateway still exists
          const verifyRes = await app.inject({
            method: "GET",
            url: `/api/agents/${gateway.id}`,
          });
          console.error(
            "DELETE GW ERROR:",
            deleteGwRes.statusCode,
            deleteGwRes.json(),
            "Verify via admin:",
            verifyRes.statusCode,
          );
        }
        expect(deleteGwRes.statusCode).toBe(200);
      } finally {
        await memberApp.close();
      }
    });
  });

  describe("scope enforcement", () => {
    test("admin can create shared agents with teams for all agent types", async ({
      makeTeam,
    }) => {
      const team = await makeTeam(organizationId, adminUser.id);

      for (const agentType of ["agent", "mcp_gateway", "llm_proxy"] as const) {
        const res = await app.inject({
          method: "POST",
          url: "/api/agents",
          payload: {
            name: `admin-team-${agentType}`,
            agentType,
            teams: [team.id],
            scope: "team",
            labels: [],
            knowledgeBaseIds: [],
            connectorIds: [],
          },
        });
        expect(res.statusCode).toBe(200);

        const created = res.json();
        // Verify via GET
        const getRes = await app.inject({
          method: "GET",
          url: `/api/agents/${created.id}`,
        });
        expect(getRes.statusCode).toBe(200);
        const agent = getRes.json();
        expect(agent.teams).toContainEqual(
          expect.objectContaining({ id: team.id }),
        );
        expect(agent.scope).toBe("team");
      }
    });

    test("team-admin can create and manage team-scoped agents", async ({
      makeCustomRole,
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, adminUser.id);

      await makeCustomRole(organizationId, {
        role: "team_admin_role",
        permission: {
          agent: ["read", "create", "update", "delete", "team-admin"],
          mcpGateway: ["read", "create", "update", "delete", "team-admin"],
          llmProxy: ["read", "create", "update", "delete", "team-admin"],
        },
      });
      await makeMember(memberUser.id, organizationId, {
        role: "team_admin_role",
      });
      await makeTeamMember(team.id, memberUser.id);

      const memberApp = await createAppForUser(memberUser);

      try {
        const createdIds: string[] = [];

        for (const agentType of [
          "agent",
          "mcp_gateway",
          "llm_proxy",
        ] as const) {
          // Can create team-scoped agents
          const createRes = await memberApp.inject({
            method: "POST",
            url: "/api/agents",
            payload: {
              name: `team-admin-${agentType}`,
              agentType,
              teams: [team.id],
              scope: "team",
              labels: [],
              knowledgeBaseIds: [],
              connectorIds: [],
            },
          });
          expect(createRes.statusCode).toBe(200);
          const created = createRes.json();
          createdIds.push(created.id);

          // Can update team-scoped agents
          const updateRes = await memberApp.inject({
            method: "PUT",
            url: `/api/agents/${created.id}`,
            payload: { name: `updated-team-admin-${agentType}` },
          });
          expect(updateRes.statusCode).toBe(200);
        }

        // FORBIDDEN from creating org-scoped agents
        const orgRes = await memberApp.inject({
          method: "POST",
          url: "/api/agents",
          payload: {
            name: "team-admin-org-agent",
            agentType: "agent",
            scope: "org",
            teams: [],
            labels: [],
            knowledgeBaseIds: [],
            connectorIds: [],
          },
        });
        expect(orgRes.statusCode).toBe(403);

        // Can delete team-scoped agents
        for (const id of createdIds) {
          const deleteRes = await memberApp.inject({
            method: "DELETE",
            url: `/api/agents/${id}`,
          });
          expect(deleteRes.statusCode).toBe(200);
        }
      } finally {
        await memberApp.close();
      }
    });

    test("non-admin user can only create personal agents, not shared", async ({
      makeCustomRole,
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, adminUser.id);

      await makeCustomRole(organizationId, {
        role: "no_admin",
        permission: {
          agent: ["read", "create"],
          mcpGateway: ["read", "create"],
          llmProxy: ["read", "create"],
        },
      });
      await makeMember(memberUser.id, organizationId, { role: "no_admin" });
      await makeTeamMember(team.id, memberUser.id);

      const memberApp = await createAppForUser(memberUser);

      try {
        // Forbidden from creating team-scoped agents
        for (const agentType of [
          "agent",
          "mcp_gateway",
          "llm_proxy",
        ] as const) {
          const teamRes = await memberApp.inject({
            method: "POST",
            url: "/api/agents",
            payload: {
              name: `non-admin-team-${agentType}`,
              agentType,
              teams: [team.id],
              scope: "team",
              labels: [],
              knowledgeBaseIds: [],
              connectorIds: [],
            },
          });
          expect(teamRes.statusCode).toBe(403);
        }

        // Can create personal agents for all types
        for (const agentType of [
          "agent",
          "mcp_gateway",
          "llm_proxy",
        ] as const) {
          const personalRes = await memberApp.inject({
            method: "POST",
            url: "/api/agents",
            payload: {
              name: `personal-${agentType}`,
              agentType,
              scope: "personal",
              teams: [],
              labels: [],
              knowledgeBaseIds: [],
              connectorIds: [],
            },
          });
          expect(personalRes.statusCode).toBe(200);
        }
      } finally {
        await memberApp.close();
      }
    });
  });

  describe("user permissions endpoint", () => {
    test("reflects granular resource type permissions", async ({
      makeCustomRole,
      makeMember,
    }) => {
      await makeCustomRole(organizationId, {
        role: "mixed_perms",
        permission: {
          agent: ["read"],
          mcpGateway: ["read", "create"],
          llmProxy: ["read", "create", "update"],
        },
      });
      await makeMember(memberUser.id, organizationId, {
        role: "mixed_perms",
      });
      const memberApp = await createAppForUser(memberUser);

      try {
        const res = await memberApp.inject({
          method: "GET",
          url: "/api/user/permissions",
        });
        expect(res.statusCode).toBe(200);
        const permissions = res.json();

        expect(permissions.agent).toEqual(["read"]);
        expect(permissions.mcpGateway).toEqual(["read", "create"]);
        expect(permissions.llmProxy).toEqual(["read", "create", "update"]);
      } finally {
        await memberApp.close();
      }
    });
  });

  describe("built-in agent visibility", () => {
    test("user without agent:admin cannot see built-in agents", async ({
      makeCustomRole,
      makeMember,
      makeAgent,
    }) => {
      // Create a built-in agent in the org
      await makeAgent({
        organizationId,
        agentType: "agent",
        scope: "org",
        name: "Policy Configuration Subagent",
        builtInAgentConfig: {
          name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
          autoConfigureOnToolAssignment: true,
        },
        authorId: adminUser.id,
      });

      // Give member agent read but NOT admin
      await makeCustomRole(organizationId, {
        role: "agent_no_admin",
        permission: { agent: ["read", "create", "update", "delete"] },
      });
      await makeMember(memberUser.id, organizationId, {
        role: "agent_no_admin",
      });

      // Admin should see built-in agents
      const adminRes = await app.inject({
        method: "GET",
        url: "/api/agents/all?agentType=agent",
      });
      if (adminRes.statusCode !== 200) {
        console.error("ADMIN ALL ERROR:", adminRes.json());
      }
      expect(adminRes.statusCode).toBe(200);
      const adminAgents = adminRes.json();
      const adminBuiltIn = adminAgents.filter(
        (a: { builtIn: boolean }) => a.builtIn,
      );
      expect(adminBuiltIn.length).toBeGreaterThan(0);

      // Member without admin should NOT see built-in agents
      const memberApp = await createAppForUser(memberUser);
      try {
        const memberRes = await memberApp.inject({
          method: "GET",
          url: "/api/agents/all?agentType=agent",
        });
        expect(memberRes.statusCode).toBe(200);
        const memberAgents = memberRes.json();
        const memberBuiltIn = memberAgents.filter(
          (a: { builtIn: boolean }) => a.builtIn,
        );
        expect(memberBuiltIn).toHaveLength(0);
      } finally {
        await memberApp.close();
      }
    });
  });
});

import { MARKETING_TEAM_NAME, MEMBER_EMAIL } from "../../consts";
import { expect, test } from "./fixtures";

/**
 * E2E tests for agent-type permission isolation.
 *
 * Verifies that the 3-resource RBAC split (agent, mcpGateway, llmProxy)
 * correctly enforces access control. A user with permissions on one resource
 * should NOT be able to access the other two.
 *
 * Also verifies scope-based access: members/editors can only CRUD personal
 * agents, while admins can CRUD both personal and shared (team/org) agents.
 *
 * These tests temporarily change the member user's role to a custom role,
 * then restore it after each test.
 */
test.describe("Agent Type Permission Isolation", () => {
  // Run serially since we modify the shared member user's role
  test.describe.configure({ mode: "serial" });

  test("user with only mcpGateway permissions cannot access agents or llm proxies", async ({
    request,
    makeApiRequest,
    createRole,
    deleteRole,
    createMcpGateway,
    deleteAgent,
    memberRequest,
    getActiveOrganizationId,
  }) => {
    const organizationId = await getActiveOrganizationId(request);
    const timestamp = Date.now();

    // Create a custom role with only mcpGateway permissions
    const roleResponse = await createRole(request, {
      name: `mcp_gw_only_${timestamp}`,
      permission: {
        mcpGateway: ["read", "create", "update", "delete"],
      },
    });
    const customRole = await roleResponse.json();

    // Get member's membership ID
    const membersResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/auth/organization/list-members",
    });
    const membersData = await membersResponse.json();
    const memberMembership = membersData.members.find(
      (m: { user: { email: string } }) => m.user.email === MEMBER_EMAIL,
    );
    expect(memberMembership).toBeDefined();

    // Save original role to restore later
    const originalRole = memberMembership.role;

    try {
      // Assign custom role to member
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: customRole.role,
          organizationId,
        },
      });

      // Member should be able to list MCP gateways
      const mcpGwResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/agents?agentType=mcp_gateway",
        ignoreStatusCheck: true,
      });
      expect(mcpGwResponse.status()).toBe(200);

      // Member should be FORBIDDEN from listing agents
      const agentResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/agents?agentType=agent",
        ignoreStatusCheck: true,
      });
      expect(agentResponse.status()).toBe(403);

      // Member should be FORBIDDEN from listing LLM proxies
      const llmProxyResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/agents?agentType=llm_proxy",
        ignoreStatusCheck: true,
      });
      expect(llmProxyResponse.status()).toBe(403);

      // Member should be able to create a personal MCP gateway
      const createGwResponse = await createMcpGateway(
        memberRequest,
        `test-gw-${timestamp}`,
        "personal",
      );
      const createdGw = await createGwResponse.json();

      // Member should be FORBIDDEN from creating an agent
      const createAgentResponse = await makeApiRequest({
        request: memberRequest,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `test-agent-${timestamp}`,
          agentType: "agent",
          scope: "personal",
        },
        ignoreStatusCheck: true,
      });
      expect(createAgentResponse.status()).toBe(403);

      // Member should be FORBIDDEN from creating an LLM proxy
      const createProxyResponse = await makeApiRequest({
        request: memberRequest,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `test-proxy-${timestamp}`,
          agentType: "llm_proxy",
          scope: "personal",
        },
        ignoreStatusCheck: true,
      });
      expect(createProxyResponse.status()).toBe(403);

      // Clean up the created gateway
      await deleteAgent(request, createdGw.id);
    } finally {
      // Restore original role
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: originalRole,
          organizationId,
        },
      });
      // Clean up custom role
      await deleteRole(request, customRole.id);
    }
  });

  test("user with only llmProxy permissions cannot access agents or mcp gateways", async ({
    request,
    makeApiRequest,
    createRole,
    deleteRole,
    createLlmProxy,
    deleteAgent,
    memberRequest,
    getActiveOrganizationId,
  }) => {
    const organizationId = await getActiveOrganizationId(request);
    const timestamp = Date.now();

    // Create a custom role with only llmProxy permissions
    const roleResponse = await createRole(request, {
      name: `llm_proxy_only_${timestamp}`,
      permission: {
        llmProxy: ["read", "create", "update", "delete"],
      },
    });
    const customRole = await roleResponse.json();

    // Get member's membership ID
    const membersResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/auth/organization/list-members",
    });
    const membersData = await membersResponse.json();
    const memberMembership = membersData.members.find(
      (m: { user: { email: string } }) => m.user.email === MEMBER_EMAIL,
    );
    const originalRole = memberMembership.role;

    try {
      // Assign custom role to member
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: customRole.role,
          organizationId,
        },
      });

      // Member should be able to list LLM proxies
      const llmResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/agents?agentType=llm_proxy",
        ignoreStatusCheck: true,
      });
      expect(llmResponse.status()).toBe(200);

      // Member should be FORBIDDEN from listing agents
      const agentResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/agents?agentType=agent",
        ignoreStatusCheck: true,
      });
      expect(agentResponse.status()).toBe(403);

      // Member should be FORBIDDEN from listing MCP gateways
      const mcpGwResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/agents?agentType=mcp_gateway",
        ignoreStatusCheck: true,
      });
      expect(mcpGwResponse.status()).toBe(403);

      // Member should be able to create a personal LLM proxy
      const createProxyResponse = await createLlmProxy(
        memberRequest,
        `test-proxy-${timestamp}`,
        "personal",
      );
      const createdProxy = await createProxyResponse.json();

      // Clean up the created proxy
      await deleteAgent(request, createdProxy.id);
    } finally {
      // Restore original role
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: originalRole,
          organizationId,
        },
      });
      await deleteRole(request, customRole.id);
    }
  });

  test("user with only agent permissions cannot access mcp gateways or llm proxies", async ({
    request,
    makeApiRequest,
    createRole,
    deleteRole,
    memberRequest,
    getActiveOrganizationId,
  }) => {
    const organizationId = await getActiveOrganizationId(request);
    const timestamp = Date.now();

    // Create a custom role with only agent permissions
    const roleResponse = await createRole(request, {
      name: `agent_only_${timestamp}`,
      permission: {
        agent: ["read", "create", "update", "delete"],
      },
    });
    const customRole = await roleResponse.json();

    // Get member's membership ID
    const membersResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/auth/organization/list-members",
    });
    const membersData = await membersResponse.json();
    const memberMembership = membersData.members.find(
      (m: { user: { email: string } }) => m.user.email === MEMBER_EMAIL,
    );
    const originalRole = memberMembership.role;

    try {
      // Assign custom role to member
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: customRole.role,
          organizationId,
        },
      });

      // Member should be able to list agents
      const agentResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/agents?agentType=agent",
        ignoreStatusCheck: true,
      });
      expect(agentResponse.status()).toBe(200);

      // Member should be FORBIDDEN from listing MCP gateways
      const mcpGwResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/agents?agentType=mcp_gateway",
        ignoreStatusCheck: true,
      });
      expect(mcpGwResponse.status()).toBe(403);

      // Member should be FORBIDDEN from listing LLM proxies
      const llmResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/agents?agentType=llm_proxy",
        ignoreStatusCheck: true,
      });
      expect(llmResponse.status()).toBe(403);
    } finally {
      // Restore original role
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: originalRole,
          organizationId,
        },
      });
      await deleteRole(request, customRole.id);
    }
  });

  test("user with mixed permissions can access allowed types only", async ({
    request,
    makeApiRequest,
    createRole,
    deleteRole,
    memberRequest,
    getActiveOrganizationId,
  }) => {
    const organizationId = await getActiveOrganizationId(request);
    const timestamp = Date.now();

    // Create a custom role with agent + mcpGateway but NOT llmProxy
    const roleResponse = await createRole(request, {
      name: `agent_gw_${timestamp}`,
      permission: {
        agent: ["read", "create"],
        mcpGateway: ["read", "create"],
      },
    });
    const customRole = await roleResponse.json();

    // Get member's membership ID
    const membersResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/auth/organization/list-members",
    });
    const membersData = await membersResponse.json();
    const memberMembership = membersData.members.find(
      (m: { user: { email: string } }) => m.user.email === MEMBER_EMAIL,
    );
    const originalRole = memberMembership.role;

    try {
      // Assign custom role to member
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: customRole.role,
          organizationId,
        },
      });

      // Member should be able to list agents
      const agentResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/agents?agentType=agent",
        ignoreStatusCheck: true,
      });
      expect(agentResponse.status()).toBe(200);

      // Member should be able to list MCP gateways
      const mcpGwResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/agents?agentType=mcp_gateway",
        ignoreStatusCheck: true,
      });
      expect(mcpGwResponse.status()).toBe(200);

      // Member should be FORBIDDEN from listing LLM proxies
      const llmResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/agents?agentType=llm_proxy",
        ignoreStatusCheck: true,
      });
      expect(llmResponse.status()).toBe(403);
    } finally {
      // Restore original role
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: originalRole,
          organizationId,
        },
      });
      await deleteRole(request, customRole.id);
    }
  });

  test("user permissions are checked on get/update/delete individual agent", async ({
    request,
    makeApiRequest,
    createRole,
    deleteRole,
    createLlmProxy,
    createMcpGateway,
    deleteAgent,
    memberRequest,
    getActiveOrganizationId,
  }) => {
    const organizationId = await getActiveOrganizationId(request);
    const timestamp = Date.now();

    // Admin creates an LLM proxy and an MCP gateway for testing
    const proxyResponse = await createLlmProxy(
      request,
      `perm-test-proxy-${timestamp}`,
      "personal",
    );
    const proxy = await proxyResponse.json();

    const gwResponse = await createMcpGateway(
      request,
      `perm-test-gw-${timestamp}`,
      "personal",
    );
    const gateway = await gwResponse.json();

    // Create a custom role with only mcpGateway permissions
    const roleResponse = await createRole(request, {
      name: `gw_crud_${timestamp}`,
      permission: {
        mcpGateway: ["read", "update", "delete", "admin"],
      },
    });
    const customRole = await roleResponse.json();

    // Get member's membership ID
    const membersResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/auth/organization/list-members",
    });
    const membersData = await membersResponse.json();
    const memberMembership = membersData.members.find(
      (m: { user: { email: string } }) => m.user.email === MEMBER_EMAIL,
    );
    const originalRole = memberMembership.role;

    try {
      // Assign custom role to member
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: customRole.role,
          organizationId,
        },
      });

      // Member CAN get the MCP gateway
      const getGwResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: `/api/agents/${gateway.id}`,
        ignoreStatusCheck: true,
      });
      expect(getGwResponse.status()).toBe(200);

      // Member CANNOT get the LLM proxy (returns 404 to avoid leaking existence)
      const getProxyResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: `/api/agents/${proxy.id}`,
        ignoreStatusCheck: true,
      });
      expect(getProxyResponse.status()).toBe(404);

      // Member CAN update the MCP gateway
      const updateGwResponse = await makeApiRequest({
        request: memberRequest,
        method: "put",
        urlSuffix: `/api/agents/${gateway.id}`,
        data: { name: `updated-gw-${timestamp}` },
        ignoreStatusCheck: true,
      });
      expect(updateGwResponse.status()).toBe(200);

      // Member CANNOT update the LLM proxy
      const updateProxyResponse = await makeApiRequest({
        request: memberRequest,
        method: "put",
        urlSuffix: `/api/agents/${proxy.id}`,
        data: { name: `updated-proxy-${timestamp}` },
        ignoreStatusCheck: true,
      });
      expect(updateProxyResponse.status()).toBe(404);

      // Member CANNOT delete the LLM proxy
      const deleteProxyResponse = await makeApiRequest({
        request: memberRequest,
        method: "delete",
        urlSuffix: `/api/agents/${proxy.id}`,
        ignoreStatusCheck: true,
      });
      expect(deleteProxyResponse.status()).toBe(404);

      // Member CAN delete the MCP gateway
      const deleteGwResponse = await makeApiRequest({
        request: memberRequest,
        method: "delete",
        urlSuffix: `/api/agents/${gateway.id}`,
        ignoreStatusCheck: true,
      });
      expect(deleteGwResponse.status()).toBe(200);
    } finally {
      // Restore original role
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: originalRole,
          organizationId,
        },
      });
      // Clean up (admin context)
      await deleteAgent(request, proxy.id).catch(() => {});
      await deleteAgent(request, gateway.id).catch(() => {});
      await deleteRole(request, customRole.id);
    }
  });

  test("admin can create shared agents with teams for all agent types", async ({
    request,
    makeApiRequest,
    deleteAgent,
    getTeamByName,
  }) => {
    const timestamp = Date.now();
    const marketingTeam = await getTeamByName(request, MARKETING_TEAM_NAME);

    const agentTypes = ["agent", "mcp_gateway", "llm_proxy"] as const;
    const createdIds: string[] = [];

    try {
      for (const agentType of agentTypes) {
        const response = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: "/api/agents",
          data: {
            name: `admin-team-${agentType}-${timestamp}`,
            agentType,
            teams: [marketingTeam.id],
            scope: "team",
          },
        });
        const created = await response.json();
        createdIds.push(created.id);

        // Verify the agent was created with team assignment
        const getResponse = await makeApiRequest({
          request,
          method: "get",
          urlSuffix: `/api/agents/${created.id}`,
        });
        const agent = await getResponse.json();
        expect(agent.teams).toContainEqual(
          expect.objectContaining({ id: marketingTeam.id }),
        );
        expect(agent.scope).toBe("team");
      }
    } finally {
      for (const id of createdIds) {
        await deleteAgent(request, id).catch(() => {});
      }
    }
  });

  test("user with team-admin can create and manage team-scoped agents", async ({
    request,
    makeApiRequest,
    createRole,
    deleteRole,
    deleteAgent,
    memberRequest,
    getActiveOrganizationId,
    getTeamByName,
  }) => {
    const organizationId = await getActiveOrganizationId(request);
    const timestamp = Date.now();
    const marketingTeam = await getTeamByName(request, MARKETING_TEAM_NAME);

    // Create a role with CRUD + team-admin but no admin
    const roleResponse = await createRole(request, {
      name: `team_admin_${timestamp}`,
      permission: {
        agent: ["read", "create", "update", "delete", "team-admin"],
        mcpGateway: ["read", "create", "update", "delete", "team-admin"],
        llmProxy: ["read", "create", "update", "delete", "team-admin"],
      },
    });
    const customRole = await roleResponse.json();

    const membersResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/auth/organization/list-members",
    });
    const membersData = await membersResponse.json();
    const memberMembership = membersData.members.find(
      (m: { user: { email: string } }) => m.user.email === MEMBER_EMAIL,
    );
    const originalRole = memberMembership.role;
    const createdIds: string[] = [];

    try {
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: customRole.role,
          organizationId,
        },
      });

      // User with team-admin should be able to create team-scoped agents
      for (const agentType of ["agent", "mcp_gateway", "llm_proxy"]) {
        const resp = await makeApiRequest({
          request: memberRequest,
          method: "post",
          urlSuffix: "/api/agents",
          data: {
            name: `team-admin-${agentType}-${timestamp}`,
            agentType,
            teams: [marketingTeam.id],
            scope: "team",
          },
          ignoreStatusCheck: true,
        });
        expect(resp.status()).toBe(200);
        const created = await resp.json();
        createdIds.push(created.id);

        // User with team-admin should be able to update team-scoped agents
        const updateResp = await makeApiRequest({
          request: memberRequest,
          method: "put",
          urlSuffix: `/api/agents/${created.id}`,
          data: { name: `updated-team-admin-${agentType}-${timestamp}` },
          ignoreStatusCheck: true,
        });
        expect(updateResp.status()).toBe(200);
      }

      // User with team-admin should be FORBIDDEN from creating org-scoped agents
      const orgResp = await makeApiRequest({
        request: memberRequest,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `team-admin-org-agent-${timestamp}`,
          agentType: "agent",
          scope: "org",
        },
        ignoreStatusCheck: true,
      });
      expect(orgResp.status()).toBe(403);

      // User with team-admin should be able to delete team-scoped agents
      for (const id of createdIds) {
        const deleteResp = await makeApiRequest({
          request: memberRequest,
          method: "delete",
          urlSuffix: `/api/agents/${id}`,
          ignoreStatusCheck: true,
        });
        expect(deleteResp.status()).toBe(200);
      }
      createdIds.length = 0;
    } finally {
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: originalRole,
          organizationId,
        },
      });
      for (const id of createdIds) {
        await deleteAgent(request, id).catch(() => {});
      }
      await deleteRole(request, customRole.id);
    }
  });

  test("non-admin user can only create personal agents, not shared", async ({
    request,
    makeApiRequest,
    createAgent,
    createLlmProxy,
    createMcpGateway,
    createRole,
    deleteRole,
    deleteAgent,
    memberRequest,
    getActiveOrganizationId,
    getTeamByName,
  }) => {
    const organizationId = await getActiveOrganizationId(request);
    const timestamp = Date.now();
    const marketingTeam = await getTeamByName(request, MARKETING_TEAM_NAME);

    // Create a role with create+read on all types but no admin
    const roleResponse = await createRole(request, {
      name: `no_admin_${timestamp}`,
      permission: {
        agent: ["read", "create"],
        mcpGateway: ["read", "create"],
        llmProxy: ["read", "create"],
      },
    });
    const customRole = await roleResponse.json();

    const membersResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/auth/organization/list-members",
    });
    const membersData = await membersResponse.json();
    const memberMembership = membersData.members.find(
      (m: { user: { email: string } }) => m.user.email === MEMBER_EMAIL,
    );
    const originalRole = memberMembership.role;
    const createdIds: string[] = [];

    try {
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: customRole.role,
          organizationId,
        },
      });

      // Member should be FORBIDDEN from creating shared (team-scoped) agents
      for (const agentType of ["agent", "mcp_gateway", "llm_proxy"]) {
        const withTeams = await makeApiRequest({
          request: memberRequest,
          method: "post",
          urlSuffix: "/api/agents",
          data: {
            name: `non-admin-team-${agentType}-${timestamp}`,
            agentType,
            teams: [marketingTeam.id],
            scope: "team",
          },
          ignoreStatusCheck: true,
        });
        expect(withTeams.status()).toBe(403);
      }

      // Member should be able to create personal agents for all types
      const agentResp = await createAgent(
        memberRequest,
        `non-admin-personal-agent-${timestamp}`,
        "personal",
      );
      createdIds.push((await agentResp.json()).id);

      const gwResp = await createMcpGateway(
        memberRequest,
        `non-admin-personal-gw-${timestamp}`,
        "personal",
      );
      createdIds.push((await gwResp.json()).id);

      const proxyResp = await createLlmProxy(
        memberRequest,
        `non-admin-personal-proxy-${timestamp}`,
        "personal",
      );
      createdIds.push((await proxyResp.json()).id);
    } finally {
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: originalRole,
          organizationId,
        },
      });
      for (const id of createdIds) {
        await deleteAgent(request, id).catch(() => {});
      }
      await deleteRole(request, customRole.id);
    }
  });

  test("user permissions endpoint reflects new resource types", async ({
    request,
    makeApiRequest,
    createRole,
    deleteRole,
    memberRequest,
    getActiveOrganizationId,
  }) => {
    const organizationId = await getActiveOrganizationId(request);
    const timestamp = Date.now();

    // Create a custom role with specific permissions across all three types
    const roleResponse = await createRole(request, {
      name: `mixed_perms_${timestamp}`,
      permission: {
        agent: ["read"],
        mcpGateway: ["read", "create"],
        llmProxy: ["read", "create", "update"],
      },
    });
    const customRole = await roleResponse.json();

    // Get member's membership ID
    const membersResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/auth/organization/list-members",
    });
    const membersData = await membersResponse.json();
    const memberMembership = membersData.members.find(
      (m: { user: { email: string } }) => m.user.email === MEMBER_EMAIL,
    );
    const originalRole = memberMembership.role;

    try {
      // Assign custom role to member
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: customRole.role,
          organizationId,
        },
      });

      // Check user permissions endpoint returns correct permissions
      const permResponse = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/user/permissions",
      });
      const permissions = await permResponse.json();

      expect(permissions.agent).toEqual(["read"]);
      expect(permissions.mcpGateway).toEqual(["read", "create"]);
      expect(permissions.llmProxy).toEqual(["read", "create", "update"]);
    } finally {
      // Restore original role
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/auth/organization/update-member-role",
        data: {
          memberId: memberMembership.id,
          role: originalRole,
          organizationId,
        },
      });
      await deleteRole(request, customRole.id);
    }
  });
});

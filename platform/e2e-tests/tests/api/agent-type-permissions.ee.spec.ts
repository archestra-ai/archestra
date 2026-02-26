import { MARKETING_TEAM_NAME, MEMBER_EMAIL } from "../../consts";
import { expect, test } from "./fixtures";

/**
 * E2E tests for agent-type permission isolation.
 *
 * Verifies that the 3-resource RBAC split (agent, mcpGateway, llmProxy)
 * correctly enforces access control. A user with permissions on one resource
 * should NOT be able to access the other two.
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
      const createGwResponse = await makeApiRequest({
        request: memberRequest,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `test-gw-${timestamp}`,
          agentType: "mcp_gateway",
        },
        ignoreStatusCheck: true,
      });
      expect(createGwResponse.status()).toBe(200);
      const createdGw = await createGwResponse.json();

      // Member should be FORBIDDEN from creating an agent
      const createAgentResponse = await makeApiRequest({
        request: memberRequest,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `test-agent-${timestamp}`,
          agentType: "agent",
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
        },
        ignoreStatusCheck: true,
      });
      expect(createProxyResponse.status()).toBe(403);

      // Clean up the created gateway
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/agents/${createdGw.id}`,
        ignoreStatusCheck: true,
      });
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
      const createProxyResponse = await makeApiRequest({
        request: memberRequest,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `test-proxy-${timestamp}`,
          agentType: "llm_proxy",
        },
        ignoreStatusCheck: true,
      });
      expect(createProxyResponse.status()).toBe(200);
      const createdProxy = await createProxyResponse.json();

      // Clean up the created proxy
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/agents/${createdProxy.id}`,
        ignoreStatusCheck: true,
      });
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
    memberRequest,
    getActiveOrganizationId,
  }) => {
    const organizationId = await getActiveOrganizationId(request);
    const timestamp = Date.now();

    // Admin creates an LLM proxy and an MCP gateway for testing
    const proxyResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/agents",
      data: {
        name: `perm-test-proxy-${timestamp}`,
        agentType: "llm_proxy",
        teams: [],
      },
    });
    const proxy = await proxyResponse.json();

    const gwResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/agents",
      data: {
        name: `perm-test-gw-${timestamp}`,
        agentType: "mcp_gateway",
        teams: [],
      },
    });
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
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/agents/${proxy.id}`,
        ignoreStatusCheck: true,
      });
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/agents/${gateway.id}`,
        ignoreStatusCheck: true,
      });
      await deleteRole(request, customRole.id);
    }
  });

  test("admin can create shared agents with teams for all agent types", async ({
    request,
    makeApiRequest,
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
          },
          ignoreStatusCheck: true,
        });
        expect(response.status()).toBe(200);
        const created = await response.json();
        createdIds.push(created.id);

        // Verify the agent was created with team scope
        const getResponse = await makeApiRequest({
          request,
          method: "get",
          urlSuffix: `/api/agents/${created.id}`,
        });
        const agent = await getResponse.json();
        expect(agent.teams).toContainEqual(
          expect.objectContaining({ id: marketingTeam.id }),
        );
      }
    } finally {
      for (const id of createdIds) {
        await makeApiRequest({
          request,
          method: "delete",
          urlSuffix: `/api/agents/${id}`,
          ignoreStatusCheck: true,
        });
      }
    }
  });

  test("non-admin user cannot create shared agents with teams", async ({
    request,
    makeApiRequest,
    createRole,
    deleteRole,
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

      for (const agentType of ["agent", "mcp_gateway", "llm_proxy"]) {
        // With teams → 403
        const withTeams = await makeApiRequest({
          request: memberRequest,
          method: "post",
          urlSuffix: "/api/agents",
          data: {
            name: `non-admin-team-${agentType}-${timestamp}`,
            agentType,
            teams: [marketingTeam.id],
          },
          ignoreStatusCheck: true,
        });
        expect(withTeams.status()).toBe(403);

        // Without teams → 200 (personal agent)
        const personal = await makeApiRequest({
          request: memberRequest,
          method: "post",
          urlSuffix: "/api/agents",
          data: {
            name: `non-admin-personal-${agentType}-${timestamp}`,
            agentType,
          },
          ignoreStatusCheck: true,
        });
        expect(personal.status()).toBe(200);

        // Clean up the personal agent
        const created = await personal.json();
        await makeApiRequest({
          request,
          method: "delete",
          urlSuffix: `/api/agents/${created.id}`,
          ignoreStatusCheck: true,
        });
      }
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

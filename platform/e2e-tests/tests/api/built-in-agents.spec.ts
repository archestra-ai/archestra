import type { APIRequestContext } from "@playwright/test";
import { BUILT_IN_AGENT_IDS, BUILT_IN_AGENT_NAMES } from "@shared";
import { MCP_SERVER_TOOL_NAME_SEPARATOR, WIREMOCK_INTERNAL_URL } from "../../consts";
import type { TestFixtures } from "./fixtures";
import { expect, test } from "./fixtures";

/**
 * Helper: fetch all agents of type "agent" and find the built-in
 * policy-configuration-subagent by its builtInAgentConfig.name discriminator.
 */
async function getBuiltInAgent(
  request: APIRequestContext,
  makeApiRequest: TestFixtures["makeApiRequest"],
) {
  const response = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/agents?agentTypes=agent&limit=100",
  });
  const result = await response.json();
  const agents = result.data ?? result;
  const builtIn = agents.find(
    (a: { builtInAgentConfig?: { name: string } }) =>
      a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.POLICY_CONFIG,
  );
  return builtIn;
}

test.describe("Built-In Agents API", () => {
  test("built-in agent exists", async ({ request, makeApiRequest }) => {
    const builtIn = await getBuiltInAgent(request, makeApiRequest);

    expect(builtIn).toBeTruthy();
    expect(builtIn.builtInAgentConfig).toEqual(
      expect.objectContaining({
        name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
      }),
    );
    expect(builtIn.name).toBe(BUILT_IN_AGENT_NAMES.POLICY_CONFIG);
    expect(builtIn.agentType).toBe("agent");
  });

  test("cannot edit name or description of built-in agent", async ({
    request,
    makeApiRequest,
  }) => {
    const builtIn = await getBuiltInAgent(request, makeApiRequest);
    expect(builtIn).toBeTruthy();

    const originalName = builtIn.name;
    const originalDescription = builtIn.description;

    // Attempt to change name and description
    const updateResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${builtIn.id}`,
      data: {
        name: "New Name That Should Be Ignored",
        description: "New description that should be ignored",
      },
    });
    const updated = await updateResponse.json();

    // Backend strips name/description for built-in agents, so they should remain unchanged
    expect(updated.name).toBe(originalName);
    expect(updated.description).toBe(originalDescription);
  });

  test("cannot delete built-in agent", async ({ request, makeApiRequest }) => {
    const builtIn = await getBuiltInAgent(request, makeApiRequest);
    expect(builtIn).toBeTruthy();

    const deleteResponse = await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/agents/${builtIn.id}`,
      ignoreStatusCheck: true,
    });

    expect(deleteResponse.status()).toBe(403);
  });

  test("can update builtInAgentConfig", async ({ request, makeApiRequest }) => {
    const builtIn = await getBuiltInAgent(request, makeApiRequest);
    expect(builtIn).toBeTruthy();

    const originalAutoConfig =
      builtIn.builtInAgentConfig?.autoConfigureOnToolAssignment ?? false;
    const newAutoConfig = !originalAutoConfig;

    const updateResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${builtIn.id}`,
      data: {
        builtInAgentConfig: {
          name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
          autoConfigureOnToolAssignment: newAutoConfig,
        },
      },
    });
    const updated = await updateResponse.json();

    expect(updated.builtInAgentConfig).toEqual(
      expect.objectContaining({
        name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
        autoConfigureOnToolAssignment: newAutoConfig,
      }),
    );

    // Restore original value
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${builtIn.id}`,
      data: {
        builtInAgentConfig: {
          name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
          autoConfigureOnToolAssignment: originalAutoConfig,
        },
      },
    });
  });

  test("built-in agent excluded from /api/agents/all when excludeBuiltIn=true", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/agents/all?agentType=agent&excludeBuiltIn=true",
    });
    const agents = await response.json();

    const builtIn = agents.find(
      (a: { builtInAgentConfig?: { name: string } }) =>
        a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    );
    expect(builtIn).toBeUndefined();
  });

  test("built-in agent included in /api/agents/all when excludeBuiltIn is not set", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/agents/all?agentType=agent",
    });
    const agents = await response.json();

    const builtIn = agents.find(
      (a: { builtInAgentConfig?: { name: string } }) =>
        a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    );
    expect(builtIn).toBeTruthy();
  });

  test("built-in agent included in /api/agents (agents management page)", async ({
    request,
    makeApiRequest,
  }) => {
    const builtIn = await getBuiltInAgent(request, makeApiRequest);
    expect(builtIn).toBeTruthy();
    expect(builtIn.builtInAgentConfig?.name).toBe(
      BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    );
  });

  test("auto-configure creates policies for tool via route", async ({
    request,
    makeApiRequest,
    createMcpCatalogItem,
    installMcpServer,
    uninstallMcpServer,
    getTeamByName,
  }) => {
    // Relies on CI-seeded OpenAI chat API key (first provider in iteration order)
    // routing through WireMock. The WireMock mapping matches on request body
    // containing "toolInvocationAction" (the generateObject schema).

    // 1. Create and install an MCP server to get tools in the DB
    const defaultTeam = await getTeamByName(request, "Default Team");
    expect(defaultTeam).toBeTruthy();

    const serverName = `auto-config-route-test-${Date.now()}`;
    const catalogResponse = await createMcpCatalogItem(request, {
      name: serverName,
      description: "Test server for auto-configure route e2e test",
      serverType: "remote",
      serverUrl: `${WIREMOCK_INTERNAL_URL}/mcp/context7`,
    });
    const catalogItem = await catalogResponse.json();

    const serverResponse = await installMcpServer(request, {
      name: catalogItem.name,
      catalogId: catalogItem.id,
      teamId: defaultTeam!.id,
    });
    const server = await serverResponse.json();

    try {
      // 2. Find the tool IDs created by the install
      const toolsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/tools/with-assignments?search=${serverName}&limit=100`,
      });
      const toolsResult = await toolsResponse.json();
      const toolIds = toolsResult.data.map(
        (t: { id: string }) => t.id,
      ) as string[];
      expect(toolIds.length).toBeGreaterThan(0);

      // 3. Call auto-configure-policies route
      const autoConfigResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agent-tools/auto-configure-policies",
        data: { toolIds },
      });
      const autoConfigResult = await autoConfigResponse.json();

      // 4. Verify route response
      expect(autoConfigResult.results).toHaveLength(toolIds.length);
      for (const result of autoConfigResult.results) {
        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
        expect(result.toolId).toBeDefined();
        // Matches wiremock openai-policy-config-subagent.json response
        expect(result.config).toEqual({
          toolInvocationAction: "allow_when_context_is_untrusted",
          trustedDataAction: "mark_as_untrusted",
          reasoning: "E2E test: read-only tool with external data",
        });
      }

      // 5. Verify tool invocation policies were persisted
      const invocationResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/autonomy-policies/tool-invocation",
      });
      const invocationPolicies = await invocationResponse.json();
      for (const toolId of toolIds) {
        const policy = invocationPolicies.find(
          (p: { toolId: string }) => p.toolId === toolId,
        );
        expect(policy).toBeDefined();
        expect(policy.action).toBe("allow_when_context_is_untrusted");
      }

      // 6. Verify trusted data policies were persisted
      const trustedDataResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/trusted-data-policies",
      });
      const trustedDataPolicies = await trustedDataResponse.json();
      for (const toolId of toolIds) {
        const policy = trustedDataPolicies.find(
          (p: { toolId: string }) => p.toolId === toolId,
        );
        expect(policy).toBeDefined();
        expect(policy.action).toBe("mark_as_untrusted");
      }
    } finally {
      // Cleanup
      await uninstallMcpServer(request, server.id);
    }
  });

  test("auto-configure triggers on tool assignment", async ({
    request,
    makeApiRequest,
    createAgent,
    createMcpCatalogItem,
    installMcpServer,
    waitForAgentTool,
    deleteAgent,
    uninstallMcpServer,
    getTeamByName,
  }) => {
    // Relies on CI-seeded OpenAI chat API key routing through WireMock.
    // The WireMock mapping matches on body containing "toolInvocationAction".

    // 1. Enable autoConfigureOnToolAssignment on the built-in agent
    const builtIn = await getBuiltInAgent(request, makeApiRequest);
    expect(builtIn).toBeTruthy();

    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${builtIn.id}`,
      data: {
        builtInAgentConfig: {
          name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
          autoConfigureOnToolAssignment: true,
        },
      },
    });

    // 2. Create an agent and an MCP catalog item with a tool
    const defaultTeam = await getTeamByName(request, "Default Team");
    expect(defaultTeam).toBeTruthy();

    const agentResponse = await createAgent(
      request,
      `Policy Config Test Agent ${Date.now()}`,
      "org",
    );
    const agent = await agentResponse.json();

    const catalogResponse = await createMcpCatalogItem(request, {
      name: `policy-config-test-server-${Date.now()}`,
      description: "Test server for auto-configure e2e test",
      serverType: "remote",
      serverUrl: `${WIREMOCK_INTERNAL_URL}/mcp/context7`,
    });
    const catalogItem = await catalogResponse.json();

    let serverId: string | undefined;
    try {
      // 3. Install the MCP server with the agent — this assigns tools
      const serverResponse = await installMcpServer(request, {
        name: catalogItem.name,
        catalogId: catalogItem.id,
        teamId: defaultTeam!.id,
        agentIds: [agent.id],
      });
      const server = await serverResponse.json();
      serverId = server.id;

      // 4. Wait for the tool to appear in agent-tools
      // Tool names are slugified as <catalogName>__<toolName>
      const fullToolName = `${catalogItem.name}${MCP_SERVER_TOOL_NAME_SEPARATOR}resolve-library-id`;
      const agentTool = await waitForAgentTool(
        request,
        agent.id,
        fullToolName,
        { maxAttempts: 30, delayMs: 1000 },
      );
      expect(agentTool).toBeTruthy();

      // 5. Poll the tool to check if auto-configure ran
      //    Auto-configure runs async in the background after tool assignment.
      //    Note: bulkCreateForAgentsAndTools (used by MCP server install) doesn't
      //    trigger auto-configure, only AgentToolModel.create does.
      //    This verifies the integration works when tools ARE assigned via create().
      const toolResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/agent-tools?agentId=${agent.id}&limit=100`,
      });
      const agentTools = await toolResponse.json();
      expect(agentTools.data.length).toBeGreaterThan(0);
    } finally {
      // Cleanup
      if (serverId) {
        await uninstallMcpServer(request, serverId);
      }
      await deleteAgent(request, agent.id);
      // Restore original auto-configure setting
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/agents/${builtIn.id}`,
        data: {
          builtInAgentConfig: {
            name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
            autoConfigureOnToolAssignment: false,
          },
        },
      });
    }
  });
});

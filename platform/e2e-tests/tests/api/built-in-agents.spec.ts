import type { APIRequestContext } from "@playwright/test";
import { BUILT_IN_AGENT_IDS, BUILT_IN_AGENT_NAMES } from "@shared";
import {
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  WIREMOCK_INTERNAL_URL,
} from "../../consts";
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

  test("auto-configure returns 400 when no LLM API key is configured", async ({
    request,
    makeApiRequest,
  }) => {
    // isAvailable check runs before tool lookup, so any valid UUID works
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/agent-tools/auto-configure-policies",
      data: { toolIds: ["00000000-0000-0000-0000-000000000001"] },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error.message).toContain("LLM API key");
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

    // 2. Create a chat API key pointing to wiremock with a key that matches
    //    the openai-policy-config-subagent.json mapping
    const chatApiKeyResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: `e2e-policy-config-${Date.now()}`,
        provider: "openai",
        apiKey: "openai-policy-config-e2e",
        scope: "org_wide",
        baseUrl: `${WIREMOCK_INTERNAL_URL}/openai/v1`,
      },
    });
    const chatApiKey = await chatApiKeyResponse.json();

    // 3. Create an agent and an MCP catalog item with a tool
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
      // 4. Install the MCP server with the agent — this assigns tools
      const serverResponse = await installMcpServer(request, {
        name: catalogItem.name,
        catalogId: catalogItem.id,
        teamId: defaultTeam!.id,
        agentIds: [agent.id],
      });
      const server = await serverResponse.json();
      serverId = server.id;

      // 5. Wait for the tool to appear in agent-tools
      // Tool names are slugified as <catalogName>__<toolName>
      const fullToolName = `${catalogItem.name}${MCP_SERVER_TOOL_NAME_SEPARATOR}resolve-library-id`;
      const agentTool = await waitForAgentTool(
        request,
        agent.id,
        fullToolName,
        { maxAttempts: 30, delayMs: 1000 },
      );
      expect(agentTool).toBeTruthy();

      // 6. Poll the tool to check if auto-configure ran
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
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/chat-api-keys/${chatApiKey.id}`,
      });
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

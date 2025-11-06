import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { API_BASE_URL } from "../../consts";
import utils from "../../utils";

const createAgent = async (
  request: APIRequestContext,
  apiKey: string,
  name: string = "Test Agent"
) => {
  const newAgent = {
    name,
    isDemo: false,
    teams: [],
  };

  const response = await request.post(`${API_BASE_URL}/api/agents`, {
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    data: newAgent,
  });

  if (!response.ok()) {
    throw new Error(
      `Failed to create agent: ${response.status()} ${await response.text()}`
    );
  }

  return response.json();
};

test.describe("MCP Gateway - Archestra Tools", () => {
  let apiKey: string;
  let apiKeyId: string;
  let agentId: string;

  test.beforeAll(async ({ request }) => {
    // Create API key for testing
    const keyData = await utils.auth.createApiKey(
      request,
      "MCP Gateway Test Key"
    );
    apiKey = keyData.key;
    apiKeyId = keyData.id;

    // Create an agent for testing
    const agent = await createAgent(request, apiKey, "MCP Gateway Test Agent");
    agentId = agent.id;
  });

  test.afterAll(async ({ request }) => {
    // Clean up API key after tests
    if (apiKeyId) {
      await utils.auth.deleteApiKey(request, apiKeyId);
    }
  });

  test("should include Archestra MCP tools in list tools response", async ({
    request,
  }) => {
    // Initialize MCP session
    const initResponse = await request.post(`${API_BASE_URL}/v1/mcp`, {
      headers: {
        Authorization: `Bearer ${agentId}`,
        "Content-Type": "application/json",
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          clientInfo: {
            name: "test-client",
            version: "1.0.0",
          },
        },
      },
    });

    expect(initResponse.status()).toBe(200);
    const initResult = await initResponse.json();
    expect(initResult).toHaveProperty("result");

    const sessionId = initResponse.headers()["mcp-session-id"];

    // Call tools/list
    const listToolsResponse = await request.post(`${API_BASE_URL}/v1/mcp`, {
      headers: {
        Authorization: `Bearer ${agentId}`,
        "Content-Type": "application/json",
        "mcp-session-id": sessionId || "",
      },
      data: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    });

    expect(listToolsResponse.status()).toBe(200);
    const listResult = await listToolsResponse.json();
    expect(listResult).toHaveProperty("result");
    expect(listResult.result).toHaveProperty("tools");

    const tools = listResult.result.tools;
    expect(Array.isArray(tools)).toBe(true);

    // Find Archestra tools
    const archestraWhoami = tools.find(
      (t: any) =>
        t.name === `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`
    );
    const archestraSearch = tools.find(
      (t: any) =>
        t.name ===
        `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`
    );

    // Verify whoami tool
    expect(archestraWhoami).toBeDefined();
    expect(archestraWhoami.title).toBe("Who Am I");
    expect(archestraWhoami.description).toContain(
      "name and ID of the current agent"
    );

    // Verify search_private_mcp_registry tool
    expect(archestraSearch).toBeDefined();
    expect(archestraSearch.title).toBe("Search Private MCP Registry");
    expect(archestraSearch.description).toContain("private MCP registry");

    // TODO: Re-enable when create_mcp_server_installation_request is implemented
    // // Verify create_mcp_server_installation_request tool
    // expect(archestraCreate).toBeDefined();
    // expect(archestraCreate.title).toBe(
    //   "Create MCP Server Installation Request"
    // );
    // expect(archestraCreate.description).toContain("install an MCP server");
  });
});

import { APIRequestContext, expect, test } from "@playwright/test";
import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { API_BASE_URL } from "../../consts";
import utils from "../../utils";

test.describe("MCP Gateway - Archestra Tools", () => {
  let agentId: string;

  test.beforeAll(async ({ request }) => {
    const agent = await utils.agent.createAgent(request, "MCP Gateway Test Agent");
    agentId = agent.id;
  });

  test.afterAll(async ({ request }) => {
    await utils.agent.deleteAgent(request, agentId);
  });

  const makeMcpGatewayRequest = (request: APIRequestContext, data: any, sessionId?: string) =>
    request.post(`${API_BASE_URL}/v1/mcp`, {
      headers: {
        Authorization: `Bearer ${agentId}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId && { "mcp-session-id": sessionId }),
      },
      data,
    });

  test("should include Archestra MCP tools in list tools response", async ({
    request,
  }) => {
    // Initialize MCP session
    const initResponse = await makeMcpGatewayRequest(request, {
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
    });

    expect(initResponse.status()).toBe(200);
    const initResult = await initResponse.json();
    expect(initResult).toHaveProperty("result");

    const sessionId = initResponse.headers()["mcp-session-id"];

    // Call tools/list
    const listToolsResponse = await makeMcpGatewayRequest(request, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, sessionId);

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

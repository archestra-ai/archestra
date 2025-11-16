import {
  MCP_GATEWAY_URL_SUFFIX,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "../../consts";
import { expect, test } from "./fixtures";

test.describe("MCP Gateway - Archestra Tools", () => {
  let profileId: string;

  test.beforeAll(async ({ request, createAgent }) => {
    const createResponse = await createAgent(
      request,
      "MCP Gateway Test Profile",
    );
    const profile = await createResponse.json();
    profileId = profile.id;
  });

  test.afterAll(async ({ request, deleteAgent }) => {
    await deleteAgent(request, profileId);
  });

  const makeMcpGatewayRequestHeaders = (sessionId?: string) => ({
    Authorization: `Bearer ${profileId}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(sessionId && { "mcp-session-id": sessionId }),
  });

  test("should include Archestra MCP tools in list tools response", async ({
    request,
    makeApiRequest,
  }) => {
    // Initialize MCP session
    const initResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: MCP_GATEWAY_URL_SUFFIX,
      headers: makeMcpGatewayRequestHeaders(),
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
    const listToolsResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: MCP_GATEWAY_URL_SUFFIX,
      headers: makeMcpGatewayRequestHeaders(sessionId),
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
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (t: any) => t.name === `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
    );
    const archestraSearch = tools.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (t: any) =>
        t.name ===
        `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
    );

    // Verify whoami tool
    expect(archestraWhoami).toBeDefined();
    expect(archestraWhoami.title).toBe("Who Am I");
    expect(archestraWhoami.description).toContain(
      "name and ID of the current profile",
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

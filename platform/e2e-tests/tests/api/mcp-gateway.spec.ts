import {
  MCP_GATEWAY_URL_SUFFIX,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "../../consts";
import { expect, test } from "./fixtures";

/**
 * MCP Gateway Authentication Tests
 *
 * Tests both authentication methods:
 * 1. LEGACY: POST /v1/mcp with Authorization: Bearer <profile_id>
 * 2. NEW: POST /v1/mcp/<profile_id> with Authorization: Bearer <archestra_token>
 */

test.describe("MCP Gateway - Legacy Auth (profile ID as token)", () => {
  let profileId: string;

  test.beforeAll(async ({ request, createAgent }) => {
    const createResponse = await createAgent(
      request,
      "MCP Gateway Legacy Auth Test",
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

  test("should initialize session and list tools", async ({
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
  });

  test("should invoke whoami tool successfully", async ({
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
          capabilities: { tools: {} },
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
    });

    expect(initResponse.status()).toBe(200);
    const sessionId = initResponse.headers()["mcp-session-id"];

    // Call whoami tool
    const callToolResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: MCP_GATEWAY_URL_SUFFIX,
      headers: makeMcpGatewayRequestHeaders(sessionId),
      data: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
          arguments: {},
        },
      },
    });

    expect(callToolResponse.status()).toBe(200);
    const callResult = await callToolResponse.json();
    expect(callResult).toHaveProperty("result");
    expect(callResult.result).toHaveProperty("content");

    // Verify the response contains profile info
    const content = callResult.result.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);

    const textContent = content.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (c: any) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain(profileId);
  });
});

test.describe("MCP Gateway - New Auth (archestra token)", () => {
  let profileId: string;
  let archestraToken: string;

  test.beforeAll(async ({ request, createAgent, makeApiRequest }) => {
    // Create test profile
    const createResponse = await createAgent(
      request,
      "MCP Gateway New Auth Test",
    );
    const profile = await createResponse.json();
    profileId = profile.id;

    // Get the Organization Token
    const tokensResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/profiles/${profileId}/tokens`,
    });
    const tokens = await tokensResponse.json();
    const orgToken = tokens.find(
      (t: { isOrganizationToken: boolean }) => t.isOrganizationToken,
    );

    // Rotate the token to get the actual value
    const rotateResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/profiles/${profileId}/tokens/${orgToken.id}/rotate`,
    });
    const rotatedToken = await rotateResponse.json();
    archestraToken = rotatedToken.value;
  });

  test.afterAll(async ({ request, deleteAgent }) => {
    await deleteAgent(request, profileId);
  });

  const makeMcpGatewayRequestHeaders = (sessionId?: string) => ({
    Authorization: `Bearer ${archestraToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(sessionId && { "mcp-session-id": sessionId }),
  });

  test("should initialize session with archestra token", async ({
    request,
    makeApiRequest,
  }) => {
    // Initialize MCP session using new auth: /v1/mcp/<profile_id> with archestra token
    const initResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: makeMcpGatewayRequestHeaders(),
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
    });

    expect(initResponse.status()).toBe(200);
    const initResult = await initResponse.json();
    expect(initResult).toHaveProperty("result");
    expect(initResult.result).toHaveProperty("serverInfo");
    expect(initResult.result.serverInfo.name).toContain(profileId);
  });

  test("should list tools with archestra token", async ({
    request,
    makeApiRequest,
  }) => {
    // Initialize session first
    const initResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: makeMcpGatewayRequestHeaders(),
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
    });

    const sessionId = initResponse.headers()["mcp-session-id"];

    // Call tools/list
    const listToolsResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
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

    // Verify Archestra tools are present
    const archestraWhoami = tools.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (t: any) => t.name === `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
    );
    expect(archestraWhoami).toBeDefined();
  });

  test("should invoke whoami tool with archestra token", async ({
    request,
    makeApiRequest,
  }) => {
    // Initialize session first
    const initResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: makeMcpGatewayRequestHeaders(),
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
    });

    const sessionId = initResponse.headers()["mcp-session-id"];

    // Call whoami tool
    const callToolResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: makeMcpGatewayRequestHeaders(sessionId),
      data: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
          arguments: {},
        },
      },
    });

    expect(callToolResponse.status()).toBe(200);
    const callResult = await callToolResponse.json();
    expect(callResult).toHaveProperty("result");
    expect(callResult.result).toHaveProperty("content");

    // Verify the response contains profile info
    const content = callResult.result.content;
    const textContent = content.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (c: any) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain(profileId);
  });

  test("should reject invalid archestra token", async ({
    request,
    makeApiRequest,
  }) => {
    const invalidHeaders = {
      Authorization: "Bearer archestra_invalid_token_12345",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    const initResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: invalidHeaders,
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
      ignoreStatusCheck: true,
    });

    expect(initResponse.status()).toBe(401);
  });
});

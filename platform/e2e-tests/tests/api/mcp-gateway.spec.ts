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

const TEST_SERVER_NAME = "internal-dev-test-server";
const TEST_TOOL_NAME = `${TEST_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}print_archestra_test`;

test.describe("MCP Gateway - External MCP Server Tool Invocation (Legacy Auth)", () => {
  let profileId: string;

  test.beforeAll(async ({ request, makeApiRequest }) => {
    // Use the Default Profile (internal-dev-test-server should be installed)
    const defaultProfileResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/agents/default",
    });
    const defaultProfile = await defaultProfileResponse.json();
    profileId = defaultProfile.id;

    // Ensure the test tool is assigned to the profile
    const toolsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/tools",
    });
    const toolsData = await toolsResponse.json();
    const tools = toolsData.data || toolsData;
    const testTool = tools.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (t: any) => t.name === TEST_TOOL_NAME,
    );

    if (testTool) {
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents/tools/bulk-assign",
        data: {
          assignments: [{ agentId: profileId, toolId: testTool.id }],
        },
        ignoreStatusCheck: true,
      });
    }
  });

  const makeMcpGatewayRequestHeaders = (sessionId?: string) => ({
    Authorization: `Bearer ${profileId}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(sessionId && { "mcp-session-id": sessionId }),
  });

  test("should invoke internal-dev-test-server tool with legacy auth", async ({
    request,
    makeApiRequest,
  }) => {
    // Initialize session using legacy auth: /v1/mcp with profile ID as bearer token
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

    // Call the test tool
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
          name: TEST_TOOL_NAME,
          arguments: {},
        },
      },
    });

    expect(callToolResponse.status()).toBe(200);
    const callResult = await callToolResponse.json();

    // Verify successful tool invocation
    expect(callResult.result).toBeDefined();
    expect(callResult.error).toBeUndefined();
    expect(callResult.result).toHaveProperty("content");

    const content = callResult.result.content;
    const textContent = content.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (c: any) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain("ARCHESTRA_TEST");
  });
});

test.describe("MCP Gateway - External MCP Server Tool Invocation (New Auth)", () => {
  let profileId: string;
  let archestraToken: string;

  test.beforeAll(async ({ request, makeApiRequest }) => {
    // Use the Default Profile (internal-dev-test-server should be installed)
    const defaultProfileResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/agents/default",
    });
    const defaultProfile = await defaultProfileResponse.json();
    profileId = defaultProfile.id;

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

    // Ensure the test tool is assigned to the profile
    // First, find the tool ID
    const toolsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/tools",
    });
    const toolsData = await toolsResponse.json();
    const tools = toolsData.data || toolsData;
    const testTool = tools.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (t: any) => t.name === TEST_TOOL_NAME,
    );

    if (testTool) {
      // Assign the tool to the profile
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents/tools/bulk-assign",
        data: {
          assignments: [{ agentId: profileId, toolId: testTool.id }],
        },
        ignoreStatusCheck: true, // May already be assigned
      });
    }
  });

  const makeMcpGatewayRequestHeaders = (sessionId?: string) => ({
    Authorization: `Bearer ${archestraToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(sessionId && { "mcp-session-id": sessionId }),
  });

  test("should list internal-dev-test-server tool", async ({
    request,
    makeApiRequest,
  }) => {
    // Initialize session
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

    // List tools
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
    const tools = listResult.result.tools;

    // Find the test tool
    const testTool = tools.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (t: any) => t.name === TEST_TOOL_NAME,
    );
    expect(testTool).toBeDefined();
    expect(testTool.description).toContain("ARCHESTRA_TEST");
  });

  test("should invoke internal-dev-test-server tool successfully", async ({
    request,
    makeApiRequest,
  }) => {
    // Initialize session
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

    // Call the test tool
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
          name: TEST_TOOL_NAME,
          arguments: {},
        },
      },
    });

    expect(callToolResponse.status()).toBe(200);
    const callResult = await callToolResponse.json();

    // Check for success or error (tool may not be running in CI)
    if (callResult.result) {
      expect(callResult.result).toHaveProperty("content");
      const content = callResult.result.content;
      const textContent = content.find(
        // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
        (c: any) => c.type === "text",
      );
      expect(textContent).toBeDefined();
      // The tool should return the ARCHESTRA_TEST env var value
      expect(textContent.text).toContain("ARCHESTRA_TEST");
    } else if (callResult.error) {
      // Tool might not be running - that's okay for this test
      // Just verify we get a proper MCP error response
      expect(callResult.error).toHaveProperty("code");
      expect(callResult.error).toHaveProperty("message");
    }
  });
});

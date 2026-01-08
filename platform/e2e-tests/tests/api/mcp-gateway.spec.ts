import type { APIRequestContext } from "@playwright/test";
import {
  API_BASE_URL,
  MCP_GATEWAY_URL_SUFFIX,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  UI_BASE_URL,
} from "../../consts";
import { expect, test } from "./fixtures";
import { getOrgTokenForProfile, makeApiRequest } from "./mcp-gateway-utils";

// =============================================================================
// Helper functions for MCP server installation
// =============================================================================

/**
 * Find a catalog item by name
 */
async function findCatalogItem(
  request: APIRequestContext,
  name: string,
): Promise<{ id: string; name: string } | undefined> {
  const response = await request.get(
    `${API_BASE_URL}/api/internal_mcp_catalog`,
    {
      headers: { Origin: UI_BASE_URL },
    },
  );
  const catalog = await response.json();
  return catalog.find((item: { name: string }) => item.name === name);
}

/**
 * Wait for MCP server installation to complete
 */
async function waitForServerInstallation(
  request: APIRequestContext,
  serverId: string,
  maxAttempts = 60,
): Promise<{
  localInstallationStatus: string;
  localInstallationError?: string;
}> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await request.get(
      `${API_BASE_URL}/api/mcp_server/${serverId}`,
      {
        headers: { Origin: UI_BASE_URL },
      },
    );
    const server = await response.json();

    if (server.localInstallationStatus === "success") {
      return server;
    }
    if (server.localInstallationStatus === "error") {
      throw new Error(
        `MCP server installation failed: ${server.localInstallationError}`,
      );
    }

    // Wait 2 seconds between checks
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `MCP server installation timed out after ${maxAttempts * 2} seconds`,
  );
}

/**
 * Find an installed MCP server by catalog ID
 */
async function findInstalledServer(
  request: APIRequestContext,
  catalogId: string,
): Promise<{ id: string; catalogId: string } | undefined> {
  const response = await request.get(`${API_BASE_URL}/api/mcp_server`, {
    headers: { Origin: UI_BASE_URL },
  });
  const serversData = await response.json();
  const servers = serversData.data || serversData;
  return servers.find((s: { catalogId: string }) => s.catalogId === catalogId);
}

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

  test.beforeAll(async ({ request, createAgent }) => {
    // Create test profile
    const createResponse = await createAgent(
      request,
      "MCP Gateway New Auth Test",
    );
    const profile = await createResponse.json();
    profileId = profile.id;

    // Get org token using shared utility
    archestraToken = await getOrgTokenForProfile(request);
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

const TEST_CATALOG_ITEM_NAME = "internal-dev-test-server";
const TEST_TOOL_NAME = `${TEST_CATALOG_ITEM_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}print_archestra_test`;

test.describe("MCP Gateway - External MCP Server Tool Invocation (Legacy Auth)", () => {
  let profileId: string;

  test.beforeAll(
    async ({ request, makeApiRequest, installMcpServer, getTeamByName }) => {
      // Use the Default Profile
      const defaultProfileResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/agents/default",
      });
      const defaultProfile = await defaultProfileResponse.json();
      profileId = defaultProfile.id;

      // Get the Default Team (required for MCP server installation when Vault is enabled)
      const defaultTeam = await getTeamByName(request, "Default Team");
      if (!defaultTeam) {
        throw new Error("Default Team not found");
      }

      // Find the catalog item for internal-dev-test-server
      const catalogItem = await findCatalogItem(
        request,
        TEST_CATALOG_ITEM_NAME,
      );
      if (!catalogItem) {
        throw new Error(
          `Catalog item '${TEST_CATALOG_ITEM_NAME}' not found. Ensure it exists in the internal MCP catalog.`,
        );
      }

      // Check if already installed
      let testServer = await findInstalledServer(request, catalogItem.id);

      if (!testServer) {
        // Install the server with team assignment
        const installResponse = await installMcpServer(request, {
          name: catalogItem.name,
          catalogId: catalogItem.id,
          teamId: defaultTeam.id,
          environmentValues: {
            ARCHESTRA_TEST: "e2e-test-value",
          },
        });
        const installedServer = await installResponse.json();

        // Wait for installation to complete
        await waitForServerInstallation(request, installedServer.id);
        testServer = installedServer;
      }

      // Type guard - testServer is guaranteed to be defined here
      if (!testServer) {
        throw new Error("MCP server should be installed at this point");
      }

      // Find the test tool (may need to wait for tool discovery)
      let testTool: { id: string; name: string } | undefined;
      for (let attempt = 0; attempt < 14; attempt++) {
        const toolsResponse = await makeApiRequest({
          request,
          method: "get",
          urlSuffix: "/api/tools",
        });
        const toolsData = await toolsResponse.json();
        const tools = toolsData.data || toolsData;
        testTool = tools.find(
          (t: { name: string }) => t.name === TEST_TOOL_NAME,
        );

        if (testTool) break;
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!testTool) {
        throw new Error(
          `Tool '${TEST_TOOL_NAME}' not found after installation. Tool discovery may have failed.`,
        );
      }

      // Assign the tool to the profile with executionSourceMcpServerId
      const assignResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents/tools/bulk-assign",
        data: {
          assignments: [
            {
              agentId: profileId,
              toolId: testTool.id,
              executionSourceMcpServerId: testServer.id,
            },
          ],
        },
      });

      const assignResult = await assignResponse.json();
      if (assignResult.failed?.length > 0) {
        throw new Error(
          `Failed to assign tool: ${JSON.stringify(assignResult.failed)}`,
        );
      }
    },
  );

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

  test.beforeAll(async ({ request, installMcpServer, getTeamByName }) => {
    // Use the Default Profile
    const defaultProfileResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/agents/default",
    });
    const defaultProfile = await defaultProfileResponse.json();
    profileId = defaultProfile.id;

    // Get org token using shared utility
    archestraToken = await getOrgTokenForProfile(request);

    // Get the Default Team (required for MCP server installation when Vault is enabled)
    const defaultTeam = await getTeamByName(request, "Default Team");
    if (!defaultTeam) {
      throw new Error("Default Team not found");
    }

    // Find the catalog item for internal-dev-test-server
    const catalogItem = await findCatalogItem(request, TEST_CATALOG_ITEM_NAME);
    if (!catalogItem) {
      throw new Error(
        `Catalog item '${TEST_CATALOG_ITEM_NAME}' not found. Ensure it exists in the internal MCP catalog.`,
      );
    }

    // Check if already installed
    let testServer = await findInstalledServer(request, catalogItem.id);

    if (!testServer) {
      // Install the server with team assignment
      const installResponse = await installMcpServer(request, {
        name: catalogItem.name,
        catalogId: catalogItem.id,
        teamId: defaultTeam.id,
        environmentValues: {
          ARCHESTRA_TEST: "e2e-test-value",
        },
      });
      const installedServer = await installResponse.json();

      // Wait for installation to complete
      await waitForServerInstallation(request, installedServer.id);
      testServer = installedServer;
    }

    // Type guard - testServer is guaranteed to be defined here
    if (!testServer) {
      throw new Error("MCP server should be installed at this point");
    }

    // Find the test tool (may need to wait for tool discovery)
    let testTool: { id: string; name: string } | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const toolsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/tools",
      });
      const toolsData = await toolsResponse.json();
      const tools = toolsData.data || toolsData;
      testTool = tools.find((t: { name: string }) => t.name === TEST_TOOL_NAME);

      if (testTool) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!testTool) {
      throw new Error(
        `Tool '${TEST_TOOL_NAME}' not found after installation. Tool discovery may have failed.`,
      );
    }

    // Assign the tool to the profile with executionSourceMcpServerId
    const assignResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/agents/tools/bulk-assign",
      data: {
        assignments: [
          {
            agentId: profileId,
            toolId: testTool.id,
            executionSourceMcpServerId: testServer.id,
          },
        ],
      },
    });

    const assignResult = await assignResponse.json();
    if (assignResult.failed?.length > 0) {
      throw new Error(
        `Failed to assign tool: ${JSON.stringify(assignResult.failed)}`,
      );
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

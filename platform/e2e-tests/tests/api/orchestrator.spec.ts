import {
  MCP_GATEWAY_URL_SUFFIX,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "../../consts";
import { expect, test } from "./fixtures";

test.describe("Orchestrator - MCP Server Installation and Execution", () => {
  // Helper function to initialize MCP session and get session ID
  const initializeMcpSession = async (
    request: ReturnType<typeof test.use>,
    makeApiRequest: any,
    agentId: string,
  ) => {
    const initResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: MCP_GATEWAY_URL_SUFFIX,
      headers: {
        Authorization: `Bearer ${agentId}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
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
            name: "orchestrator-test-client",
            version: "1.0.0",
          },
        },
      },
    });

    expect(initResponse.status()).toBe(200);
    const initResult = await initResponse.json();
    expect(initResult).toHaveProperty("result");

    return initResponse.headers()["mcp-session-id"];
  };

  // Helper function to list tools from MCP gateway
  const listTools = async (
    request: ReturnType<typeof test.use>,
    makeApiRequest: any,
    agentId: string,
    sessionId: string,
  ) => {
    const listToolsResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: MCP_GATEWAY_URL_SUFFIX,
      headers: {
        Authorization: `Bearer ${agentId}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
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

    return listResult.result.tools;
  };

  test.describe("Remote MCP Server", () => {
    let agentId: string;
    let catalogId: string;
    let serverId: string;

    test.beforeAll(async ({
      request,
      createAgent,
      createMcpCatalogItem,
      installMcpServer,
    }) => {
      // Create agent for testing
      const agentResponse = await createAgent(
        request,
        "Orchestrator Test Agent - Remote",
      );
      const agent = await agentResponse.json();
      agentId = agent.id;

      // Create a catalog item for a remote MCP server (GitHub)
      const catalogResponse = await createMcpCatalogItem(request, {
        name: "GitHub MCP Test",
        description: "GitHub MCP Server for testing remote installation",
        serverType: "remote",
        authFields: [
          {
            name: "access_token",
            label: "GitHub Personal Access Token",
            type: "password",
            required: true,
            description: "GitHub PAT with repo access",
          },
        ],
      });
      const catalogItem = await catalogResponse.json();
      catalogId = catalogItem.id;

      // Install the remote MCP server with a test token
      // Note: This uses a dummy token for testing
      const installResponse = await installMcpServer(request, {
        name: "Test GitHub Remote Server",
        catalogId: catalogId,
        accessToken: "ghp_test_token_for_e2e_testing",
      });
      const server = await installResponse.json();
      serverId = server.id;
    });

    test.afterAll(async ({
      request,
      deleteAgent,
      deleteMcpCatalogItem,
      uninstallMcpServer,
    }) => {
      // Clean up in reverse order
      if (serverId) await uninstallMcpServer(request, serverId);
      if (catalogId) await deleteMcpCatalogItem(request, catalogId);
      if (agentId) await deleteAgent(request, agentId);
    });

    test("should install remote MCP server and list its tools", async ({
      request,
      makeApiRequest,
    }) => {
      // Initialize MCP session
      const sessionId = await initializeMcpSession(
        request,
        makeApiRequest,
        agentId,
      );

      // List tools - remote servers should appear
      const tools = await listTools(request, makeApiRequest, agentId, sessionId);

      // We should have tools from the remote server
      // Note: Actual tools depend on the server implementation
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  test.describe("Local MCP Server - NPX Command", () => {
    let agentId: string;
    let catalogId: string;
    let serverId: string;

    test.beforeAll(async ({
      request,
      createAgent,
      createMcpCatalogItem,
      installMcpServer,
    }) => {
      // Create agent for testing
      const agentResponse = await createAgent(
        request,
        "Orchestrator Test Agent - NPX",
      );
      const agent = await agentResponse.json();
      agentId = agent.id;

      // Create a catalog item for context7 MCP server using npx
      const catalogResponse = await createMcpCatalogItem(request, {
        name: "Context7 MCP Test",
        description: "Context7 MCP Server for testing local NPX installation",
        serverType: "local",
        localConfig: {
          command: "npx",
          arguments: ["@uplink_ai/context7-mcp@latest"],
          transportType: "stdio",
          environment: [
            {
              key: "CONTEXT7_API_KEY",
              type: "secret",
              promptOnInstallation: true,
            },
          ],
        },
      });
      const catalogItem = await catalogResponse.json();
      catalogId = catalogItem.id;

      // Install the MCP server with environment values
      const installResponse = await installMcpServer(request, {
        name: "Test Context7 NPX Server",
        catalogId: catalogId,
        environmentValues: {
          CONTEXT7_API_KEY: "test_api_key_for_context7",
        },
      });
      const server = await installResponse.json();
      serverId = server.id;

      // Wait a bit for the pod to start
      await new Promise((resolve) => setTimeout(resolve, 5000));
    });

    test.afterAll(async ({
      request,
      deleteAgent,
      deleteMcpCatalogItem,
      uninstallMcpServer,
    }) => {
      // Clean up in reverse order
      if (serverId) await uninstallMcpServer(request, serverId);
      if (catalogId) await deleteMcpCatalogItem(request, catalogId);
      if (agentId) await deleteAgent(request, agentId);
    });

    test("should install local MCP server via npx and list its tools", async ({
      request,
      makeApiRequest,
    }) => {
      // Initialize MCP session
      const sessionId = await initializeMcpSession(
        request,
        makeApiRequest,
        agentId,
      );

      // List tools - should include tools from context7
      const tools = await listTools(request, makeApiRequest, agentId, sessionId);

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);

      // Context7 should expose at least one tool
      const context7Tools = tools.filter((t: any) =>
        t.name.startsWith(`test-context7-npx-server${MCP_SERVER_TOOL_NAME_SEPARATOR}`),
      );
      expect(context7Tools.length).toBeGreaterThan(0);
    });
  });

  test.describe("Local MCP Server - Docker Image", () => {
    let agentId: string;
    let catalogId: string;
    let serverId: string;

    test.beforeAll(async ({
      request,
      createAgent,
      createMcpCatalogItem,
      installMcpServer,
    }) => {
      // Create agent for testing
      const agentResponse = await createAgent(
        request,
        "Orchestrator Test Agent - Docker",
      );
      const agent = await agentResponse.json();
      agentId = agent.id;

      // Create a catalog item for an MCP server using a Docker image
      // Using mcp/fetch as an example (publicly available MCP server)
      const catalogResponse = await createMcpCatalogItem(request, {
        name: "Fetch MCP Test",
        description: "Fetch MCP Server for testing Docker image installation",
        serverType: "local",
        localConfig: {
          dockerImage: "mcp/fetch:latest",
          transportType: "stdio",
          environment: [],
        },
      });
      const catalogItem = await catalogResponse.json();
      catalogId = catalogItem.id;

      // Install the MCP server
      const installResponse = await installMcpServer(request, {
        name: "Test Fetch Docker Server",
        catalogId: catalogId,
      });
      const server = await installResponse.json();
      serverId = server.id;

      // Wait a bit for the pod to start
      await new Promise((resolve) => setTimeout(resolve, 5000));
    });

    test.afterAll(async ({
      request,
      deleteAgent,
      deleteMcpCatalogItem,
      uninstallMcpServer,
    }) => {
      // Clean up in reverse order
      if (serverId) await uninstallMcpServer(request, serverId);
      if (catalogId) await deleteMcpCatalogItem(request, catalogId);
      if (agentId) await deleteAgent(request, agentId);
    });

    test("should install local MCP server via Docker and list its tools", async ({
      request,
      makeApiRequest,
    }) => {
      // Initialize MCP session
      const sessionId = await initializeMcpSession(
        request,
        makeApiRequest,
        agentId,
      );

      // List tools - should include tools from fetch server
      const tools = await listTools(request, makeApiRequest, agentId, sessionId);

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);

      // Fetch server should expose the fetch tool
      const fetchServerTools = tools.filter((t: any) =>
        t.name.startsWith(`test-fetch-docker-server${MCP_SERVER_TOOL_NAME_SEPARATOR}`),
      );
      expect(fetchServerTools.length).toBeGreaterThan(0);

      // Verify we can find the fetch tool specifically
      const fetchTool = tools.find(
        (t: any) =>
          t.name === `test-fetch-docker-server${MCP_SERVER_TOOL_NAME_SEPARATOR}fetch`,
      );
      expect(fetchTool).toBeDefined();
      expect(fetchTool.description).toBeTruthy();
    });
  });
});

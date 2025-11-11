import {
  type APIRequestContext,
  expect,
  type TestFixtures,
  test,
} from "./fixtures";

test.describe("Orchestrator - MCP Server Installation and Execution", () => {
  /**
   * It can take some time to pull the Docker images and start the MCP server.. hence the polling
   */
  const waitForMcpServerReady = async (
    request: APIRequestContext,
    makeApiRequest: TestFixtures["makeApiRequest"],
    serverId: string,
    maxRetries = 30,
  ) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const statusResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/mcp_server/${serverId}/installation-status`,
      });

      expect(statusResponse.status()).toBe(200);
      const status = await statusResponse.json();

      if (status.localInstallationStatus === "success") {
        return;
      }

      if (status.localInstallationStatus === "error") {
        throw new Error(
          `MCP server installation failed: ${status.localInstallationError}`,
        );
      }

      // Still pending/discovering-tools, wait and retry
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(
      `MCP server installation did not complete after ${maxRetries} attempts`,
    );
  };

  const getMcpServerTools = async (
    request: APIRequestContext,
    makeApiRequest: TestFixtures["makeApiRequest"],
    serverId: string,
  ) => {
    const toolsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/mcp_server/${serverId}/tools`,
    });

    expect(toolsResponse.status()).toBe(200);
    const tools = await toolsResponse.json();
    expect(Array.isArray(tools)).toBe(true);

    return tools;
  };

  test.describe("Remote MCP Server", () => {
    let catalogId: string;
    let serverId: string;

    test.beforeAll(
      async ({
        request,
        createAgent,
        createMcpCatalogItem,
        installMcpServer,
      }) => {
        // Create agent for testing (needed for cleanup)
        await createAgent(request, "Orchestrator Test Agent - Remote");

        // Create a catalog item for context7 remote MCP server (no auth required)
        const catalogResponse = await createMcpCatalogItem(request, {
          name: "Context7 - Remote",
          description: "Context7 MCP Server for testing remote installation",
          serverType: "remote",
          serverUrl: "https://mcp.context7.com/mcp",
        });
        const catalogItem = await catalogResponse.json();
        catalogId = catalogItem.id;

        // Install the remote MCP server (no auth required)
        const installResponse = await installMcpServer(request, {
          name: "Test Context7 Remote Server",
          catalogId: catalogId,
        });
        const server = await installResponse.json();
        serverId = server.id;
      },
    );

    test.afterAll(
      async ({ request, deleteMcpCatalogItem, uninstallMcpServer }) => {
        // Clean up in reverse order
        if (serverId) await uninstallMcpServer(request, serverId);
        if (catalogId) await deleteMcpCatalogItem(request, catalogId);
      },
    );

    test("should install remote MCP server and discover its tools", async ({
      request,
      makeApiRequest,
    }) => {
      // Get tools directly from MCP server
      const tools = await getMcpServerTools(request, makeApiRequest, serverId);

      // Should have discovered tools from the remote server
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  test.describe("Local MCP Server - NPX Command", () => {
    let catalogId: string;
    let serverId: string;

    test.beforeAll(
      async ({
        request,
        makeApiRequest,
        createAgent,
        createMcpCatalogItem,
        installMcpServer,
      }) => {
        // Create agent for testing (needed for cleanup)
        await createAgent(request, "Orchestrator Test Agent - NPX");

        // Create a catalog item for context7 MCP server using npx
        const catalogResponse = await createMcpCatalogItem(request, {
          name: "Context7 - Local",
          description: "Context7 MCP Server for testing local NPX installation",
          serverType: "local",
          localConfig: {
            command: "npx",
            arguments: ["-y", "@upstash/context7-mcp"],
            transportType: "stdio",
            environment: [],
          },
        });
        const catalogItem = await catalogResponse.json();
        catalogId = catalogItem.id;

        // Install the MCP server (no environment values needed)
        const installResponse = await installMcpServer(request, {
          name: "Test Context7 NPX Server",
          catalogId: catalogId,
        });
        const server = await installResponse.json();
        serverId = server.id;

        // Wait for MCP server to be ready
        await waitForMcpServerReady(request, makeApiRequest, serverId);
      },
    );

    test.afterAll(
      async ({ request, deleteMcpCatalogItem, uninstallMcpServer }) => {
        // Clean up in reverse order
        if (serverId) await uninstallMcpServer(request, serverId);
        if (catalogId) await deleteMcpCatalogItem(request, catalogId);
      },
    );

    test("should install local MCP server via npx and discover its tools", async ({
      request,
      makeApiRequest,
    }) => {
      // Get tools directly from MCP server
      const tools = await getMcpServerTools(request, makeApiRequest, serverId);

      // Should have discovered tools from the NPX server
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  test.describe("Local MCP Server - Docker Image", () => {
    let catalogId: string;
    let serverId: string;

    test.beforeAll(
      async ({
        request,
        makeApiRequest,
        createAgent,
        createMcpCatalogItem,
        installMcpServer,
      }) => {
        // Create agent for testing (needed for cleanup)
        await createAgent(request, "Orchestrator Test Agent - Docker");

        // Create a catalog item for context7 MCP server using Docker image
        const catalogResponse = await createMcpCatalogItem(request, {
          name: "Context7 - Docker Based",
          description:
            "Context7 MCP Server for testing Docker image installation",
          serverType: "local",
          localConfig: {
            /**
             * NOTE: we use this image instead of the mcp/context7 one as this one exposes stdio..
             * the other one exposes SSE (which we don't support yet as a transport type)..
             *
             * https://github.com/dolasoft/stdio_context7_mcp
             */
            dockerImage: "dolasoft/stdio-context7-mcp",
            transportType: "stdio",
            environment: [],
          },
        });
        const catalogItem = await catalogResponse.json();
        catalogId = catalogItem.id;

        // Install the MCP server
        const installResponse = await installMcpServer(request, {
          name: "Test Context7 Docker Server",
          catalogId: catalogId,
        });
        const server = await installResponse.json();
        serverId = server.id;

        // Wait for MCP server to be ready
        await waitForMcpServerReady(request, makeApiRequest, serverId);
      },
    );

    test.afterAll(
      async ({ request, deleteMcpCatalogItem, uninstallMcpServer }) => {
        // Clean up in reverse order
        if (serverId) await uninstallMcpServer(request, serverId);
        if (catalogId) await deleteMcpCatalogItem(request, catalogId);
      },
    );

    test("should install local MCP server via Docker and discover its tools", async ({
      request,
      makeApiRequest,
    }) => {
      // Get tools directly from MCP server
      const tools = await getMcpServerTools(request, makeApiRequest, serverId);

      // Should have discovered tools from the Docker server
      expect(tools.length).toBeGreaterThan(0);
    });
  });
});

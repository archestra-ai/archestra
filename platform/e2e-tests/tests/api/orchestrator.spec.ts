import {
  type APIRequestContext,
  expect,
  type TestFixtures,
  test,
} from "./fixtures";

/**
 * Retry wrapper for external service calls that may fail due to network issues.
 * Uses exponential backoff.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

test.describe("Orchestrator - MCP Server Installation and Execution", () => {
  /**
   * It can take some time to pull the Docker images and start the MCP server.. hence the polling
   * In CI environments with parallel workers, this can take longer due to resource contention
   */
  const waitForMcpServerReady = async (
    request: APIRequestContext,
    makeApiRequest: TestFixtures["makeApiRequest"],
    serverId: string,
    maxRetries = 60,
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
        getTeamByName,
      }) => {
        // Create agent for testing (needed for cleanup)
        await createAgent(request, "Orchestrator Test Agent - Remote");

        // Get the Default Team (required for MCP server installation when Vault is enabled)
        const defaultTeam = await getTeamByName(request, "Default Team");
        if (!defaultTeam) {
          throw new Error("Default Team not found");
        }

        // Create a catalog item for context7 remote MCP server (no auth required)
        const catalogResponse = await createMcpCatalogItem(request, {
          name: "Context7 - Remote",
          description: "Context7 MCP Server for testing remote installation",
          serverType: "remote",
          serverUrl: "https://mcp.context7.com/mcp",
        });
        const catalogItem = await catalogResponse.json();
        catalogId = catalogItem.id;

        // Install the remote MCP server with retry logic for network issues
        // External services can be flaky, so retry up to 3 times with exponential backoff
        const server = await withRetry(async () => {
          const installResponse = await installMcpServer(request, {
            name: "Test Context7 Remote Server",
            catalogId: catalogId,
            teamId: defaultTeam.id,
          });
          return installResponse.json();
        });
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
    // Extend timeout for this describe block since MCP server installation can take a while
    test.describe.configure({ timeout: 60_000 });

    let catalogId: string;
    let serverId: string;

    test.beforeAll(
      async ({
        request,
        makeApiRequest,
        createAgent,
        createMcpCatalogItem,
        installMcpServer,
        getTeamByName,
      }) => {
        // Create agent for testing (needed for cleanup)
        await createAgent(request, "Orchestrator Test Agent - NPX");

        // Get the Default Team (required for MCP server installation when Vault is enabled)
        const defaultTeam = await getTeamByName(request, "Default Team");
        if (!defaultTeam) {
          throw new Error("Default Team not found");
        }

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

        // Install the MCP server with team assignment
        const installResponse = await installMcpServer(request, {
          name: "Test Context7 NPX Server",
          catalogId: catalogId,
          teamId: defaultTeam.id,
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

    test("should restart local MCP server successfully", async ({
      request,
      makeApiRequest,
      restartMcpServer,
    }) => {
      // Get tools count before restart
      const toolsBefore = await getMcpServerTools(
        request,
        makeApiRequest,
        serverId,
      );
      const toolsCountBefore = toolsBefore.length;

      // Restart the MCP server
      const restartResponse = await restartMcpServer(request, serverId);
      expect(restartResponse.status()).toBe(200);
      const restartResult = await restartResponse.json();
      expect(restartResult.success).toBe(true);

      // Wait for the server to be ready after restart
      await waitForMcpServerReady(request, makeApiRequest, serverId);

      // Verify tools are still available after restart
      const toolsAfter = await getMcpServerTools(
        request,
        makeApiRequest,
        serverId,
      );
      expect(toolsAfter.length).toBe(toolsCountBefore);
    });
  });

  test.describe("Local MCP Server - Docker Image", () => {
    // Extend timeout for this describe block since Docker image pull and MCP server installation can take a while
    test.describe.configure({ timeout: 60_000 });

    let catalogId: string;
    let serverId: string;

    test.beforeAll(
      async ({
        request,
        makeApiRequest,
        createAgent,
        createMcpCatalogItem,
        installMcpServer,
        getTeamByName,
      }) => {
        // Create agent for testing (needed for cleanup)
        await createAgent(request, "Orchestrator Test Agent - Docker");

        // Get the Default Team (required for MCP server installation when Vault is enabled)
        const defaultTeam = await getTeamByName(request, "Default Team");
        if (!defaultTeam) {
          throw new Error("Default Team not found");
        }

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

        // Install the MCP server with team assignment
        const installResponse = await installMcpServer(request, {
          name: "Test Context7 Docker Server",
          catalogId: catalogId,
          teamId: defaultTeam.id,
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

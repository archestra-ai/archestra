import { TEST_CATALOG_ITEM_NAME, WIREMOCK_INTERNAL_URL } from "../../consts";
import {
  findCatalogItem,
  findInstalledServer,
  waitForServerInstallation,
} from "../../utils";
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

        // Create a catalog item for context7 remote MCP server (mocked via WireMock)
        // Use WIREMOCK_INTERNAL_URL because the backend needs to connect to WireMock
        // (In CI, backend runs in a K8s pod and needs the service DNS name)
        const catalogResponse = await createMcpCatalogItem(request, {
          name: "Context7 - Remote",
          description: "Context7 MCP Server for testing remote installation",
          serverType: "remote",
          serverUrl: `${WIREMOCK_INTERNAL_URL}/mcp/context7`,
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

  test.describe("Local MCP Server - internal-dev-test-server", () => {
    // Run tests serially on the same worker to share beforeAll setup (MCP server installation)
    // Also extend timeout since MCP server installation can take a while
    test.describe.configure({ mode: "serial", timeout: 60_000 });

    let serverId: string;

    test.beforeAll(
      async ({
        request,
        makeApiRequest,
        createAgent,
        installMcpServer,
        uninstallMcpServer,
        getTeamByName,
      }) => {
        // Create agent for testing (needed for cleanup)
        await createAgent(request, "Orchestrator Test Agent");

        // Get the Default Team (required for MCP server installation when Vault is enabled)
        const defaultTeam = await getTeamByName(request, "Default Team");
        if (!defaultTeam) {
          throw new Error("Default Team not found");
        }

        // Find the internal-dev-test-server catalog item
        const catalogItem = await findCatalogItem(
          request,
          TEST_CATALOG_ITEM_NAME,
        );
        if (!catalogItem) {
          throw new Error(
            `Catalog item '${TEST_CATALOG_ITEM_NAME}' not found. Ensure it exists in the internal MCP catalog.`,
          );
        }

        // Check if already installed for this team
        let testServer = await findInstalledServer(
          request,
          catalogItem.id,
          defaultTeam.id,
        );

        // Handle existing server based on its status
        if (testServer) {
          const statusResponse = await makeApiRequest({
            request,
            method: "get",
            urlSuffix: `/api/mcp_server/${testServer.id}/installation-status`,
          });
          const status = await statusResponse.json();

          if (status.localInstallationStatus === "error") {
            // Only uninstall if in error state - don't interrupt pending installations
            await uninstallMcpServer(request, testServer.id);
            // Wait for K8s to clean up the deployment before reinstalling
            await new Promise((resolve) => setTimeout(resolve, 5000));
            testServer = undefined;
          } else if (status.localInstallationStatus !== "success") {
            // Server is still installing (pending/discovering-tools) - wait for it
            await waitForServerInstallation(request, testServer.id);
          }
          // If already success, we'll use it as-is
        }

        if (!testServer) {
          // Install the MCP server with team assignment
          const installResponse = await installMcpServer(request, {
            name: catalogItem.name,
            catalogId: catalogItem.id,
            teamId: defaultTeam.id,
            environmentValues: {
              ARCHESTRA_TEST: "e2e-test-value",
            },
          });
          testServer = await installResponse.json();
        }

        if (!testServer) {
          throw new Error("MCP server should be installed at this point");
        }

        serverId = testServer.id;

        // Wait for MCP server to be ready
        await waitForServerInstallation(request, serverId);
      },
    );

    test.afterAll(async ({ request, uninstallMcpServer }) => {
      // Only uninstall the server, don't delete the catalog item (it's from internal catalog)
      if (serverId) await uninstallMcpServer(request, serverId);
    });

    test("should install local MCP server and discover its tools", async ({
      request,
      makeApiRequest,
    }) => {
      // Get tools directly from MCP server
      const tools = await getMcpServerTools(request, makeApiRequest, serverId);

      // Should have discovered tools from the server
      expect(tools.length).toBeGreaterThan(0);

      // Verify the test tool is present (tool name from MCP server, without server prefix)
      const testTool = tools.find((t: { name: string }) =>
        t.name.includes("print_archestra_test"),
      );
      expect(testTool).toBeDefined();
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
      await waitForServerInstallation(request, serverId);

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
        await waitForServerInstallation(request, serverId);
      },
    );

    test.afterAll(
      async ({ request, deleteMcpCatalogItem, uninstallMcpServer }) => {
        // Clean up in reverse order
        if (serverId) await uninstallMcpServer(request, serverId);
        if (catalogId) await deleteMcpCatalogItem(request, catalogId);
      },
    );

    test("should install a local MCP server via Docker and discover its tools", async ({
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

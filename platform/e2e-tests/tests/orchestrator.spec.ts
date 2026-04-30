import * as k8s from "@kubernetes/client-node";
import { MCP_SERVER_NAMESPACE, TEST_CATALOG_ITEM_NAME, WIREMOCK_INTERNAL_URL } from "../consts";
import {
  findCatalogItem,
  findInstalledServer,
  waitForServerInstallation,
} from "../utils";
import {
  type APIRequestContext,
  expect,
  type TestFixtures,
  test,
} from "./api-fixtures";

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
  // Run all describe blocks serially to avoid K8s resource contention
  // (multiple simultaneous pod deployments exhaust local cluster resources)
  test.describe.configure({ mode: "serial" });

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
        await createAgent(
          request,
          "Orchestrator Test Agent - Remote",
          "personal",
        );

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
            scope: "team",
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
    test.describe.configure({ mode: "serial", timeout: 120_000 });

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
        test.setTimeout(120_000);
        // Create agent for testing (needed for cleanup)
        await createAgent(request, "Orchestrator Test Agent", "personal");

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
            scope: "team",
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
        await createAgent(
          request,
          "Orchestrator Test Agent - Docker",
          "personal",
        );

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
          scope: "team",
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

  test.describe("K8s Namespace support", () => {
    test.describe.configure({ mode: "serial", timeout: 120_000 });

    let serverId: string;

    test.beforeAll(
      async ({
        request,
        installMcpServer,
        listK8sNamespaces,
        getTeamByName,
      }) => {
        const defaultTeam = await getTeamByName(request, "Default Team");
        if (!defaultTeam) {
          throw new Error("Default Team not found");
        }

        const catalogItem = await findCatalogItem(
          request,
          TEST_CATALOG_ITEM_NAME,
        );
        if (!catalogItem) {
          throw new Error(
            `Catalog item '${TEST_CATALOG_ITEM_NAME}' not found. Ensure it exists in the internal MCP catalog.`,
          );
        }

        const namespaces = await listK8sNamespaces(request);
        expect(namespaces.length).toBeGreaterThan(0);
        const targetNamespace: string = namespaces[0];

        const installResponse = await installMcpServer(request, {
          name: "Test Namespace Server",
          catalogId: catalogItem.id,
          scope: "team",
          teamId: defaultTeam.id,
          environmentValues: { ARCHESTRA_TEST: "namespace-test-value" },
          k8sNamespace: targetNamespace,
        });
        const server = await installResponse.json();
        serverId = server.id;

        await waitForServerInstallation(request, serverId);
      },
    );

    test.afterAll(async ({ request, uninstallMcpServer }) => {
      if (serverId) await uninstallMcpServer(request, serverId);
    });

    test("should list K8s namespaces", async ({
      request,
      listK8sNamespaces,
    }) => {
      const namespaces = await listK8sNamespaces(request);
      expect(Array.isArray(namespaces)).toBe(true);
      expect(namespaces.length).toBeGreaterThan(0);
      expect(typeof namespaces[0]).toBe("string");
    });

    test("should install MCP server with explicit namespace and discover tools", async ({
      request,
      makeApiRequest,
      listK8sNamespaces,
    }) => {
      const tools = await getMcpServerTools(request, makeApiRequest, serverId);
      expect(tools.length).toBeGreaterThan(0);

      const namespaces = await listK8sNamespaces(request);
      const targetNamespace = namespaces[0];

      const serverResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/mcp_server/${serverId}`,
      });
      const server = await serverResponse.json();
      expect(server.k8sNamespace).toBe(targetNamespace);
    });

    test("should reject install with nonexistent namespace", async ({
      request,
      installMcpServer,
    }) => {
      const catalogItem = await findCatalogItem(
        request,
        TEST_CATALOG_ITEM_NAME,
      );
      if (!catalogItem) {
        throw new Error(`Catalog item '${TEST_CATALOG_ITEM_NAME}' not found`);
      }

      const response = await installMcpServer(
        request,
        {
          name: "Test Bad Namespace Server",
          catalogId: catalogItem.id,
          environmentValues: { ARCHESTRA_TEST: "namespace-test-value" },
          k8sNamespace: "nonexistent-namespace-xyz",
        },
        { ignoreStatusCheck: true },
      );

      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.error.message).toContain("does not exist in the cluster");
    });
  });

  test.describe("Local MCP Server - Custom K8s Cluster", () => {
    test.describe.configure({ mode: "serial", timeout: 120_000 });

    let clusterId: string;
    let serverId: string;
    let teamId: string;

    test.beforeAll(
      async ({
        request,
        makeApiRequest,
        installMcpServer,
        createTeam,
        deleteTeam,
      }) => {
        test.setTimeout(120_000);
        // Export the current kubeconfig so we can register it as a "custom" cluster.
        // In e2e the platform already uses this same cluster, so the server will
        // actually deploy there — we just exercise the custom-cluster code path.
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        const kubeconfigYaml = kc.exportConfig();

        const clusterRes = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: "/api/k8s/clusters",
          data: { name: "e2e-test-cluster", kubeconfig: kubeconfigYaml },
        });
        expect(clusterRes.status()).toBe(200);
        const cluster = await clusterRes.json();
        clusterId = cluster.id;

        // Create a dedicated team to avoid catalog+team uniqueness conflict with
        // the "Local MCP Server - internal-dev-test-server" test that also uses
        // Default Team + the same catalog item.
        const teamRes = await createTeam(
          request,
          "E2E Custom Cluster Team",
          "Team for custom cluster e2e test",
        );
        const team = await teamRes.json();
        teamId = team.id;

        const catalogItem = await findCatalogItem(
          request,
          TEST_CATALOG_ITEM_NAME,
        );
        if (!catalogItem) {
          throw new Error(
            `Catalog item '${TEST_CATALOG_ITEM_NAME}' not found`,
          );
        }

        const installRes = await installMcpServer(request, {
          name: `${catalogItem.name} - custom cluster`,
          catalogId: catalogItem.id,
          scope: "team",
          teamId,
          k8sClusterId: clusterId,
          k8sNamespace: MCP_SERVER_NAMESPACE,
          environmentValues: { ARCHESTRA_TEST: "e2e-custom-cluster" },
        });
        expect(installRes.status()).toBe(200);
        const server = await installRes.json();
        serverId = server.id;

        await waitForServerInstallation(request, serverId);
      },
    );

    test.afterAll(
      async ({ request, makeApiRequest, uninstallMcpServer, deleteTeam }) => {
        if (serverId) await uninstallMcpServer(request, serverId);
        if (clusterId) {
          await makeApiRequest({
            request,
            method: "delete",
            urlSuffix: `/api/k8s/clusters/${clusterId}`,
          });
        }
        if (teamId) await deleteTeam(request, teamId);
      },
    );

    test("should install MCP server into custom cluster and discover its tools", async ({
      request,
      makeApiRequest,
    }) => {
      const tools = await getMcpServerTools(request, makeApiRequest, serverId);
      expect(tools.length).toBeGreaterThan(0);
      const testTool = tools.find((t: { name: string }) =>
        t.name.includes("print_archestra_test"),
      );
      expect(testTool).toBeDefined();
    });

    test("should store custom cluster and namespace in the database", async ({
      request,
      makeApiRequest,
    }) => {
      const serverResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/mcp_server/${serverId}`,
      });
      expect(serverResponse.status()).toBe(200);
      const server = await serverResponse.json();
      expect(server.k8sClusterId).toBe(clusterId);
      expect(server.k8sNamespace).toBe(MCP_SERVER_NAMESPACE);
    });

    test("should reject installation into custom cluster with non-existent namespace", async ({
      request,
      installMcpServer,
    }) => {
      const catalogItem = await findCatalogItem(request, TEST_CATALOG_ITEM_NAME);
      if (!catalogItem) {
        throw new Error(`Catalog item '${TEST_CATALOG_ITEM_NAME}' not found`);
      }

      const res = await installMcpServer(
        request,
        {
          name: `${catalogItem.name} - bad-namespace`,
          catalogId: catalogItem.id,
          scope: "team",
          teamId,
          k8sClusterId: clusterId,
          k8sNamespace: "this-namespace-does-not-exist",
        },
        { ignoreStatusCheck: true },
      );
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("does not exist in the cluster");
    });
  });
});

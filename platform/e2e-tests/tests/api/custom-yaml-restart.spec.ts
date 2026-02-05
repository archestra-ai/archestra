import { testMcpServerCommand } from "@shared/test-mcp-server";
import { waitForServerInstallation } from "../../utils";
import { expect, test } from "./fixtures";

test.describe("Custom YAML Spec - Server Restart on YAML Edit", () => {
  test.describe.configure({ timeout: 180_000 });

  let catalogId: string;
  let serverId: string;

  test.afterAll(
    async ({ request, deleteMcpCatalogItem, uninstallMcpServer }) => {
      if (serverId) await uninstallMcpServer(request, serverId);
      if (catalogId) await deleteMcpCatalogItem(request, catalogId);
    },
  );

  test("server auto-restarts after custom YAML is edited", async ({
    request,
    makeApiRequest,
    createMcpCatalogItem,
    installMcpServer,
    getTeamByName,
  }) => {
    const defaultTeam = await getTeamByName(request, "Default Team");
    const serverName = `yaml-restart-test-${Date.now()}`;

    // ========================================
    // STEP 1: Create catalog item (same config as internal-dev-test-server)
    // ========================================
    const catalogResponse = await createMcpCatalogItem(request, {
      name: serverName,
      description: "Test custom YAML restart",
      serverType: "local",
      localConfig: {
        command: "sh",
        arguments: ["-c", testMcpServerCommand],
        environment: [
          {
            key: "TEST_A",
            type: "plain_text" as const,
            value: "test_ui",
            promptOnInstallation: false,
          },
        ],
      },
    });
    const catalog = await catalogResponse.json();
    catalogId = catalog.id;

    // ========================================
    // STEP 2: Install and wait for server to start
    // ========================================
    const installResponse = await installMcpServer(request, {
      name: serverName,
      catalogId: catalog.id,
      teamId: defaultTeam.id,
    });
    const server = await installResponse.json();
    serverId = server.id;

    await waitForServerInstallation(request, serverId);

    const status1 = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/mcp_server/${serverId}`,
    });
    const serverData1 = await status1.json();
    expect(serverData1.localInstallationStatus).toBe("success");

    // ========================================
    // STEP 3: Get YAML and add env B
    // ========================================
    const yamlResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/internal_mcp_catalog/${catalogId}/deployment-yaml-preview`,
    });
    const { yaml: currentYaml } = await yamlResponse.json();

    const updatedYaml = currentYaml.replace(
      /(- name: TEST_A\n\s+value: \$\{env\.TEST_A\})/,
      `$1\n            - name: TEST_B\n              value: test_custom`,
    );

    // ========================================
    // STEP 4: Update catalog with new YAML (triggers auto-reinstall)
    // ========================================
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/internal_mcp_catalog/${catalogId}`,
      data: { deploymentSpecYaml: updatedYaml },
    });

    // ========================================
    // STEP 5: Wait for auto-reinstall to complete
    // The server status will go: success -> pending -> success
    // ========================================
    await waitForServerInstallation(request, serverId, 60);

    // ========================================
    // STEP 6: Verify server is running again
    // ========================================
    const status2 = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/mcp_server/${serverId}`,
    });
    const serverData2 = await status2.json();
    expect(serverData2.localInstallationStatus).toBe("success");
    expect(serverData2.reinstallRequired).toBe(false);
  });
});

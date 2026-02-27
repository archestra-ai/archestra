import * as k8s from "@kubernetes/client-node";
import { MCP_SERVER_NAMESPACE } from "../../consts";
import { waitForServerInstallation } from "../../utils";
import { expect, test } from "./fixtures";

function getK8sApi(): k8s.CoreV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}

test.describe("Image Pull Secrets", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  const TEST_EXISTING_SECRET_NAME = `e2e-test-regcred-${Date.now()}`;
  const TEST_REGISTRY = "test-registry.example.com";
  const TEST_USERNAME = "e2e-test-user";
  const TEST_PASSWORD = "e2e-test-password-123";
  const TEST_EMAIL = "e2e@example.com";

  let k8sApi: k8s.CoreV1Api;
  let catalogId: string;
  let serverId: string;

  test.beforeAll(async () => {
    k8sApi = getK8sApi();

    // Create a pre-existing dockerconfigjson secret in the target namespace
    // (simulates a secret that a user would select via "Existing Secret" mode)
    const dockerConfigJson = JSON.stringify({
      auths: {
        "existing-registry.example.com": {
          username: "existing-user",
          password: "existing-pass",
          auth: Buffer.from("existing-user:existing-pass").toString("base64"),
        },
      },
    });

    const existingSecret: k8s.V1Secret = {
      metadata: {
        name: TEST_EXISTING_SECRET_NAME,
        labels: { "e2e-test": "image-pull-secrets" },
      },
      type: "kubernetes.io/dockerconfigjson",
      data: {
        ".dockerconfigjson": Buffer.from(dockerConfigJson).toString("base64"),
      },
    };

    await k8sApi.createNamespacedSecret({
      namespace: MCP_SERVER_NAMESPACE,
      body: existingSecret,
    });
  });

  test.afterAll(
    async ({ request, deleteMcpCatalogItem, uninstallMcpServer }) => {
      // Clean up in reverse order
      if (serverId) {
        await uninstallMcpServer(request, serverId).catch(() => {});
      }
      if (catalogId) {
        await deleteMcpCatalogItem(request, catalogId).catch(() => {});
      }

      // Delete the pre-existing test secret
      try {
        await k8sApi.deleteNamespacedSecret({
          name: TEST_EXISTING_SECRET_NAME,
          namespace: MCP_SERVER_NAMESPACE,
        });
      } catch {
        // Ignore cleanup errors
      }

      // Delete any regcred secrets created by the orchestrator for this server
      if (serverId) {
        try {
          const secrets = await k8sApi.listNamespacedSecret({
            namespace: MCP_SERVER_NAMESPACE,
            labelSelector: `mcp-server-id=${serverId},type=regcred`,
          });
          for (const secret of secrets.items) {
            if (secret.metadata?.name) {
              await k8sApi.deleteNamespacedSecret({
                name: secret.metadata.name,
                namespace: MCP_SERVER_NAMESPACE,
              });
            }
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  );

  test("should create catalog item with image pull secrets and strip password from template", async ({
    request,
    createMcpCatalogItem,
    makeApiRequest,
  }) => {
    // Create a catalog item with both "existing" and "credentials" image pull secrets
    const catalogResponse = await createMcpCatalogItem(request, {
      name: `e2e-ips-test-${Date.now()}`,
      description: "E2E test for image pull secrets",
      serverType: "local",
      localConfig: {
        command: "echo",
        args: ["hello"],
        transportType: "stdio",
        environment: [],
        imagePullSecrets: [
          { source: "existing", name: TEST_EXISTING_SECRET_NAME },
          {
            source: "credentials",
            server: TEST_REGISTRY,
            username: TEST_USERNAME,
            password: TEST_PASSWORD,
            email: TEST_EMAIL,
          },
        ],
      },
    });

    const catalogItem = await catalogResponse.json();
    catalogId = catalogItem.id;
    expect(catalogId).toBeTruthy();

    // Verify the password was stripped from the stored template
    const getResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/internal_mcp_catalog/${catalogId}`,
    });
    const storedItem = await getResponse.json();

    const credentialEntry = storedItem.localConfig.imagePullSecrets?.find(
      (e: { source: string }) => e.source === "credentials",
    );
    expect(credentialEntry).toBeDefined();
    expect(credentialEntry.server).toBe(TEST_REGISTRY);
    expect(credentialEntry.username).toBe(TEST_USERNAME);
    // Password should have been stripped from the template
    expect(credentialEntry.password).toBeUndefined();

    const existingEntry = storedItem.localConfig.imagePullSecrets?.find(
      (e: { source: string }) => e.source === "existing",
    );
    expect(existingEntry).toBeDefined();
    expect(existingEntry.name).toBe(TEST_EXISTING_SECRET_NAME);
  });

  test("should install MCP server and create docker-registry K8s secrets", async ({
    request,
    installMcpServer,
    getTeamByName,
  }) => {
    // Get the Default Team (required for MCP server installation)
    const defaultTeam = await getTeamByName(request, "Default Team");
    expect(defaultTeam).toBeTruthy();

    // Install the MCP server
    const installResponse = await installMcpServer(request, {
      name: `e2e-ips-server-${Date.now()}`,
      catalogId,
      teamId: defaultTeam.id,
    });
    const server = await installResponse.json();
    serverId = server.id;
    expect(serverId).toBeTruthy();

    // Wait for server installation to complete (or fail — we don't care about
    // the server actually running, just that the k8s resources were created)
    try {
      await waitForServerInstallation(request, serverId, 60);
    } catch {
      // Installation may fail because "echo hello" isn't a real MCP server,
      // but the k8s resources should still have been created before the failure.
    }

    // Verify: orchestrator-created regcred secret exists in k8s
    const regcredSecrets = await k8sApi.listNamespacedSecret({
      namespace: MCP_SERVER_NAMESPACE,
      labelSelector: `mcp-server-id=${serverId},type=regcred`,
    });

    expect(regcredSecrets.items.length).toBe(1);
    const regcredSecret = regcredSecrets.items[0];

    // Verify secret metadata
    expect(regcredSecret.type).toBe("kubernetes.io/dockerconfigjson");
    expect(regcredSecret.metadata?.labels?.["mcp-server-id"]).toBe(serverId);
    expect(regcredSecret.metadata?.labels?.type).toBe("regcred");

    // Verify dockerconfigjson content
    const dockerConfigJsonB64 = regcredSecret.data?.[".dockerconfigjson"];
    expect(dockerConfigJsonB64).toBeTruthy();

    const dockerConfigJson = JSON.parse(
      Buffer.from(dockerConfigJsonB64 ?? "", "base64").toString("utf-8"),
    );
    expect(dockerConfigJson.auths[TEST_REGISTRY]).toBeDefined();
    expect(dockerConfigJson.auths[TEST_REGISTRY].username).toBe(TEST_USERNAME);
    expect(dockerConfigJson.auths[TEST_REGISTRY].password).toBe(TEST_PASSWORD);
    expect(dockerConfigJson.auths[TEST_REGISTRY].email).toBe(TEST_EMAIL);

    // Verify the generated secret name includes sanitized server and username
    const secretName = regcredSecret.metadata?.name ?? "";
    expect(secretName).toContain(`mcp-server-${serverId}-regcred-`);
    expect(secretName).toContain("test-registry.example.com");
    expect(secretName).toContain("e2e-test-user");
  });
});

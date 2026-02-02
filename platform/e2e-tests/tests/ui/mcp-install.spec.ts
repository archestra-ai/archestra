import * as k8s from "@kubernetes/client-node";
import type { Locator, Page as PlaywrightPage } from "@playwright/test";
import { expect } from "@playwright/test";
import { archestraApiSdk, E2eTestId } from "@shared";
import { goToPage, type Page, test } from "../../fixtures";
import { clickButton } from "../../utils";

// Initialize K8s client for deployment verification
function createK8sClient() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return {
    appsApi: kc.makeApiClient(k8s.AppsV1Api),
    coreApi: kc.makeApiClient(k8s.CoreV1Api),
    namespace: process.env.ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE || "default",
  };
}

/**
 * Sets a Monaco editor's value using keyboard.insertText to bypass auto-pairing behavior.
 * Monaco auto-pairs brackets and quotes which makes character-by-character typing unreliable.
 * Using insertText() inserts the text as if it came from a paste operation, avoiding auto-pairing.
 */
async function setMonacoEditorValue(
  page: PlaywrightPage,
  editor: Locator,
  value: string,
): Promise<void> {
  await editor.click();
  // Select all and delete existing content
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  // Use insertText to set the value (bypasses Monaco auto-pairing like a paste would)
  await page.keyboard.insertText(value);
  // Wait for Monaco to process the input
  await page.waitForTimeout(500);
}

/**
 * To cover:
 * - Custom self-hosted - out of scope because already tested in static-credentials-management.spec.ts
 * - Self-hosted from catalog
 * - Custom remote
 * - Remote from catalog
 */

test.describe("MCP Install", () => {
  test("Self-hosted from catalog", async ({
    adminPage,
    extractCookieHeaders,
  }) => {
    const CONTEXT7_CATALOG_ITEM_NAME = "upstash__context7";

    await deleteCatalogItem(
      adminPage,
      extractCookieHeaders,
      CONTEXT7_CATALOG_ITEM_NAME,
    );

    await goToPage(adminPage, "/mcp-catalog/registry");
    await adminPage.waitForLoadState("networkidle");

    // Open "Add MCP Server" dialog
    await clickButton({ page: adminPage, options: { name: "Add MCP Server" } });
    await adminPage.waitForLoadState("networkidle");

    // Search for context7
    await adminPage
      .getByRole("textbox", { name: "Search servers by name..." })
      .fill("context7");
    await adminPage.waitForLoadState("networkidle");
    // Timeout needed so filter is applied on UI
    await adminPage.waitForTimeout(3_000);

    // wait for the server to be visible and add to registry
    await adminPage
      .getByLabel("Add MCP Server to the Private")
      .getByText(CONTEXT7_CATALOG_ITEM_NAME)
      .waitFor({ state: "visible", timeout: 30000 });
    await adminPage.waitForLoadState("networkidle");
    await adminPage.getByTestId(E2eTestId.AddCatalogItemButton).first().click();
    await adminPage.waitForLoadState("networkidle");

    // Install dialog opens automatically after adding to registry
    // Wait for the install dialog to be visible
    await adminPage
      .getByRole("dialog")
      .filter({ hasText: /Install -/ })
      .waitFor({ state: "visible", timeout: 30000 });

    // fill the api key (just fake value)
    await adminPage
      .getByRole("textbox", { name: "context7_api_key *" })
      .fill("fake-api-key");

    // install the server
    await clickButton({ page: adminPage, options: { name: "Install" } });
    await adminPage.waitForLoadState("networkidle");

    // Wait for the card to appear in the registry after installation
    const serverCard = adminPage.getByTestId(
      `${E2eTestId.McpServerCard}-${CONTEXT7_CATALOG_ITEM_NAME}`,
    );
    await serverCard.waitFor({ state: "visible", timeout: 30000 });

    // Check that tools are discovered
    await serverCard
      .getByText("/2")
      .waitFor({ state: "visible", timeout: 60_000 });

    // cleanup
    await deleteCatalogItem(
      adminPage,
      extractCookieHeaders,
      CONTEXT7_CATALOG_ITEM_NAME,
    );
  });

  test.describe("Custom remote", () => {
    test.describe.configure({ mode: "serial" });

    const HF_URL = "https://huggingface.co/mcp";
    const HF_CATALOG_ITEM_NAME = "huggingface__mcp";

    test("No auth required", async ({ adminPage, extractCookieHeaders }) => {
      await deleteCatalogItem(
        adminPage,
        extractCookieHeaders,
        HF_CATALOG_ITEM_NAME,
      );
      await goToPage(adminPage, "/mcp-catalog/registry");
      await adminPage.waitForLoadState("networkidle");

      // Open "Add MCP Server" dialog
      await clickButton({
        page: adminPage,
        options: { name: "Add MCP Server" },
      });
      await adminPage.waitForLoadState("networkidle");

      // Open form and fill details
      await adminPage
        .getByRole("button", { name: "Remote (orchestrated not by Archestra)" })
        .click();
      await adminPage
        .getByRole("textbox", { name: "Name *" })
        .fill(HF_CATALOG_ITEM_NAME);
      await adminPage
        .getByRole("textbox", { name: "Server URL *" })
        .fill(HF_URL);

      // add catalog item to the registry (install dialog opens automatically)
      await clickButton({ page: adminPage, options: { name: "Add Server" } });
      await adminPage.waitForLoadState("networkidle");

      // Wait for the install dialog to be visible (Remote server uses "Install Server" title)
      await adminPage
        .getByRole("dialog")
        .filter({ hasText: /Install Server/ })
        .waitFor({ state: "visible", timeout: 30000 });

      // install the server (install dialog already open)
      await clickButton({ page: adminPage, options: { name: "Install" } });
      await adminPage.waitForTimeout(2_000);

      // Check that tools are discovered
      await adminPage
        .getByTestId(`mcp-server-card-${HF_CATALOG_ITEM_NAME}`)
        .getByText("/9")
        .waitFor({ state: "visible" });

      // cleanup
      await deleteCatalogItem(
        adminPage,
        extractCookieHeaders,
        HF_CATALOG_ITEM_NAME,
      );
    });

    test("Bearer Token", async ({ adminPage, extractCookieHeaders }) => {
      await deleteCatalogItem(
        adminPage,
        extractCookieHeaders,
        HF_CATALOG_ITEM_NAME,
      );
      await goToPage(adminPage, "/mcp-catalog/registry");
      await adminPage.waitForLoadState("networkidle");

      // Open "Add MCP Server" dialog
      await clickButton({
        page: adminPage,
        options: { name: "Add MCP Server" },
      });
      await adminPage.waitForLoadState("networkidle");

      // Open form and fill details
      await adminPage
        .getByRole("button", { name: "Remote (orchestrated not by Archestra)" })
        .click();
      await adminPage
        .getByRole("textbox", { name: "Name *" })
        .fill(HF_CATALOG_ITEM_NAME);
      await adminPage
        .getByRole("textbox", { name: "Server URL *" })
        .fill(HF_URL);
      await adminPage
        .getByRole("radio", { name: /"Authorization: Bearer/ })
        .click();

      // add catalog item to the registry (install dialog opens automatically)
      await clickButton({ page: adminPage, options: { name: "Add Server" } });
      await adminPage.waitForLoadState("networkidle");

      // Wait for the install dialog to be visible (Remote server uses "Install Server" title)
      await adminPage
        .getByRole("dialog")
        .filter({ hasText: /Install Server/ })
        .waitFor({ state: "visible", timeout: 30000 });

      // Install dialog already open - check that we have input for entering the token and fill it with fake value
      await adminPage
        .getByRole("textbox", { name: "Access Token *" })
        .fill("fake-token");

      // try to install the server
      await clickButton({ page: adminPage, options: { name: "Install" } });
      await adminPage.waitForLoadState("networkidle");

      // It should fail with error message because token is invalid and remote hf refuses to install the server
      await adminPage
        .getByText(/Failed to connect to MCP server/)
        .waitFor({ state: "visible" });

      // cleanup
      await deleteCatalogItem(
        adminPage,
        extractCookieHeaders,
        HF_CATALOG_ITEM_NAME,
      );
    });
  });

  test("Local server with advanced K8s configuration", async ({
    adminPage,
    extractCookieHeaders,
  }) => {
    // Increase timeout to 3 minutes to allow K8s deployment to be ready
    test.setTimeout(180_000);
    const CATALOG_ITEM_NAME = "e2e__advanced_k8s_test";

    // Test values for advanced K8s config
    const testConfig = {
      replicas: 2,
      serviceAccount: "default",
      resourceRequestsMemory: "256Mi",
      resourceRequestsCpu: "100m",
      resourceLimitsMemory: "512Mi",
      resourceLimitsCpu: "500m",
      labels: { environment: "e2e-test", "test-label": "test-value" },
      annotations: {
        "app.kubernetes.io/managed-by": "archestra-e2e",
        "test-annotation": "annotation-value",
      },
    };

    // Cleanup any existing catalog item and MCP server
    await deleteCatalogItem(adminPage, extractCookieHeaders, CATALOG_ITEM_NAME);

    await goToPage(adminPage, "/mcp-catalog/registry");
    await adminPage.waitForLoadState("networkidle");

    // Open "Add MCP Server" dialog
    await clickButton({ page: adminPage, options: { name: "Add MCP Server" } });
    await adminPage.waitForLoadState("networkidle");

    // Click "Self-hosted (orchestrated by Archestra in K8s)" button
    await adminPage
      .getByRole("button", {
        name: "Self-hosted (orchestrated by Archestra in K8s)",
      })
      .click();

    // Fill basic fields
    await adminPage
      .getByRole("textbox", { name: "Name *" })
      .fill(CATALOG_ITEM_NAME);
    await adminPage
      .getByRole("textbox", { name: "Docker Image" })
      .fill("alpine:latest");
    await adminPage.getByRole("textbox", { name: "Command" }).fill("sleep");
    await adminPage
      .getByRole("textbox", { name: "Arguments (one per line)" })
      .fill("infinity");

    // Expand Advanced Configuration section
    const advancedConfigButton = adminPage.getByRole("button", {
      name: /Advanced Configuration/,
    });
    await advancedConfigButton.click();

    // Fill ALL advanced K8s configuration fields
    // 1. Replicas (spinbutton because it's a number input)
    await adminPage
      .getByRole("spinbutton", { name: "Replicas" })
      .fill(String(testConfig.replicas));

    // 2. Service Account
    await adminPage
      .getByRole("textbox", { name: "Service Account" })
      .fill(testConfig.serviceAccount);

    // 3. Resource Requests (Memory and CPU)
    await adminPage
      .getByPlaceholder("128Mi")
      .fill(testConfig.resourceRequestsMemory);
    await adminPage
      .getByPlaceholder("50m")
      .fill(testConfig.resourceRequestsCpu);

    // 4. Resource Limits (Memory and CPU)
    await adminPage
      .getByPlaceholder("256Mi")
      .fill(testConfig.resourceLimitsMemory);
    await adminPage.getByPlaceholder("500m").fill(testConfig.resourceLimitsCpu);

    // 5. Custom Labels (JSON editor)
    const labelsEditor = adminPage.locator(".monaco-editor").first();
    await setMonacoEditorValue(
      adminPage,
      labelsEditor,
      JSON.stringify(testConfig.labels),
    );

    // 6. Custom Annotations (JSON editor)
    const annotationsEditor = adminPage.locator(".monaco-editor").last();
    await setMonacoEditorValue(
      adminPage,
      annotationsEditor,
      JSON.stringify(testConfig.annotations),
    );

    // Add catalog item to the registry
    await clickButton({ page: adminPage, options: { name: "Add Server" } });
    await adminPage.waitForLoadState("networkidle");

    // Wait for the install dialog to be visible
    await adminPage
      .getByRole("dialog")
      .filter({ hasText: /Install -/ })
      .waitFor({ state: "visible", timeout: 30000 });

    // Install the server (click Install button)
    await clickButton({ page: adminPage, options: { name: "Install" } });
    await adminPage.waitForLoadState("networkidle");

    // Wait for the server card to appear
    const serverCard = adminPage.getByTestId(
      `${E2eTestId.McpServerCard}-${CATALOG_ITEM_NAME}`,
    );
    await serverCard.waitFor({ state: "visible", timeout: 30000 });

    // Wait for server card to be fully visible (don't wait for Connect since alpine:latest won't run MCP)
    await adminPage.waitForTimeout(2000);

    // ========================================
    // VERIFY ACTUAL K8S DEPLOYMENT VALUES
    // (Skip if K8s orchestrator not available, e.g., in CI)
    // ========================================
    let k8sClient: ReturnType<typeof createK8sClient> | null = null;
    let k8sAccessible = false;

    try {
      k8sClient = createK8sClient();
      // Quick health check - try to list deployments
      await k8sClient.appsApi.listNamespacedDeployment({
        namespace: k8sClient.namespace,
        limit: 1,
      });
      k8sAccessible = true;
    } catch {
      // K8s not accessible - fail the test since orchestrator should be enabled
      throw new Error(
        "K8s API not accessible. The orchestrator should be enabled in CI.",
      );
    }

    if (k8sAccessible && k8sClient) {
      // The catalog item name is slugified and used as part of the MCP server name
      // MCP server names include an org ID suffix, so we search by label
      const slugifiedName = CATALOG_ITEM_NAME.toLowerCase().replace(
        /[^a-z0-9.-]/g,
        "",
      );

      // Poll for the deployment to exist by listing with label selector
      let deployment: k8s.V1Deployment | null = null;
      const maxAttempts = 60; // 2 minutes with 2s intervals
      for (let i = 0; i < maxAttempts; i++) {
        try {
          // List all MCP server deployments and find the one matching our catalog item
          const deployments = await k8sClient.appsApi.listNamespacedDeployment({
            namespace: k8sClient.namespace,
            labelSelector: "app=mcp-server",
          });

          // Find deployment whose name contains our slugified catalog item name
          const matchingDeployment = deployments.items.find(
            (d: k8s.V1Deployment) => d.metadata?.name?.includes(slugifiedName),
          );

          if (matchingDeployment?.spec) {
            deployment = matchingDeployment;
            break;
          }
        } catch {
          // Deployment may not exist yet, keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // Assert deployment was found and extract verified properties
      expect(deployment).not.toBeNull();
      const deploymentSpec = deployment?.spec;
      const deploymentMetadata = deployment?.metadata;
      expect(deploymentSpec).toBeDefined();
      expect(deploymentMetadata?.name).toContain(slugifiedName);

      // 1. Verify replicas
      expect(deploymentSpec?.replicas).toBe(testConfig.replicas);

      // 2. Verify service account
      const podSpec = deploymentSpec?.template?.spec;
      expect(podSpec?.serviceAccountName).toBe(testConfig.serviceAccount);

      // 3. Verify resource requests
      const container = podSpec?.containers?.[0];
      expect(container).toBeDefined();
      expect(container?.resources?.requests?.memory).toBe(
        testConfig.resourceRequestsMemory,
      );
      expect(container?.resources?.requests?.cpu).toBe(
        testConfig.resourceRequestsCpu,
      );

      // 4. Verify resource limits
      expect(container?.resources?.limits?.memory).toBe(
        testConfig.resourceLimitsMemory,
      );
      expect(container?.resources?.limits?.cpu).toBe(
        testConfig.resourceLimitsCpu,
      );

      // 5. Verify custom labels (merged with required labels)
      const labels = deploymentSpec?.template?.metadata?.labels;
      expect(labels).toBeDefined();
      // Custom labels should be present (sanitized to lowercase)
      expect(labels?.environment).toBe("e2e-test");
      expect(labels?.["test-label"]).toBe("test-value");
      // Required labels should also be present
      expect(labels?.app).toBe("mcp-server");

      // 6. Verify custom annotations
      const annotations = deploymentSpec?.template?.metadata?.annotations;
      expect(annotations).toBeDefined();
      expect(annotations?.["app.kubernetes.io/managed-by"]).toBe(
        "archestra-e2e",
      );
      expect(annotations?.["test-annotation"]).toBe("annotation-value");
    }

    // Cleanup
    await deleteCatalogItem(adminPage, extractCookieHeaders, CATALOG_ITEM_NAME);
  });

  test("Local server with bogus image shows error, logs, and can be fixed", async ({
    adminPage,
    extractCookieHeaders,
  }) => {
    // Increase timeout to 4 minutes to allow for K8s deployment attempts
    test.setTimeout(240_000);
    const CATALOG_ITEM_NAME = "e2e__bogus_image_test";
    const BOGUS_IMAGE = "image-that-doesnt-exist:123";
    const PYTHON_MCP_SCRIPT =
      "from mcp.server.fastmcp import FastMCP; import anyio; app=FastMCP('e2e-test', log_level='CRITICAL'); " +
      "print_archestra_test=lambda: 'ok'; " +
      "app.add_tool(print_archestra_test, name='print_archestra_test', description='E2E test tool'); " +
      "anyio.run(app.run_stdio_async)";

    // Cleanup any existing catalog item
    await deleteCatalogItem(adminPage, extractCookieHeaders, CATALOG_ITEM_NAME);

    await goToPage(adminPage, "/mcp-catalog/registry");
    await adminPage.waitForLoadState("networkidle");

    // ========================================
    // STEP 1: Create MCP server with bogus image
    // ========================================
    await clickButton({ page: adminPage, options: { name: "Add MCP Server" } });
    await adminPage.waitForLoadState("networkidle");

    await adminPage
      .getByRole("button", {
        name: "Self-hosted (orchestrated by Archestra in K8s)",
      })
      .click();

    // Fill basic fields with bogus image
    await adminPage
      .getByRole("textbox", { name: "Name *" })
      .fill(CATALOG_ITEM_NAME);
    await adminPage
      .getByRole("textbox", { name: "Docker Image" })
      .fill(BOGUS_IMAGE);
    await adminPage.getByRole("textbox", { name: "Command" }).fill("sleep");
    await adminPage
      .getByRole("textbox", { name: "Arguments (one per line)" })
      .fill("infinity");

    // Add catalog item to registry
    await clickButton({ page: adminPage, options: { name: "Add Server" } });
    await adminPage.waitForLoadState("networkidle");

    // Wait for install dialog and install the server
    await adminPage
      .getByRole("dialog")
      .filter({ hasText: /Install -/ })
      .waitFor({ state: "visible", timeout: 30000 });
    await clickButton({ page: adminPage, options: { name: "Install" } });
    await adminPage.waitForLoadState("networkidle");

    // Wait for the server card to appear
    const serverCard = adminPage.getByTestId(
      `${E2eTestId.McpServerCard}-${CATALOG_ITEM_NAME}`,
    );
    await serverCard.waitFor({ state: "visible", timeout: 30000 });

    // ========================================
    // STEP 2: Wait for failure status (error banner)
    // ========================================
    const errorBanner = adminPage.getByTestId(
      `${E2eTestId.McpServerError}-${CATALOG_ITEM_NAME}`,
    );
    await errorBanner.waitFor({ state: "visible", timeout: 120_000 });

    // ========================================
    // STEP 3: Check logs show deployment events
    // ========================================
    // Click "view the logs" link in the error banner
    const viewLogsButton = adminPage.getByTestId(
      `${E2eTestId.McpLogsViewButton}-${CATALOG_ITEM_NAME}`,
    );
    await viewLogsButton.click();

    // Wait for logs dialog to open
    const logsDialog = adminPage.getByTestId(E2eTestId.McpLogsDialog);
    await logsDialog.waitFor({ state: "visible", timeout: 10000 });

    // Wait for logs content to appear (should show K8s events like image pull failure)
    const logsContent = adminPage.getByTestId(E2eTestId.McpLogsContent);
    await logsContent.waitFor({ state: "visible", timeout: 30000 });

    // Verify logs contain deployment events and image pull failure info
    await expect
      .poll(async () => (await logsContent.textContent()) ?? "", {
        timeout: 30_000,
      })
      .toMatch(/\S/);

    const logsText = (await logsContent.textContent()) ?? "";
    expect(logsText).toMatch(
      /(=== MCP Server Status|Pod Phase|Container 'mcp-server'|Kubernetes Events|Failed to retrieve deployment events)/i,
    );
    expect(logsText).toMatch(
      /(ErrImagePull|ImagePullBackOff|ErrImageNeverPull|Failed to pull|pull access denied|manifest unknown|repository does not exist|not found|denied)/i,
    );

    // Close the logs dialog
    await adminPage.keyboard.press("Escape");
    await logsDialog.waitFor({ state: "hidden", timeout: 5000 });

    // ========================================
    // STEP 4: Edit config to fix the image
    // ========================================
    // Click "edit your config" link in the error banner
    const editConfigButton = adminPage.getByTestId(
      `${E2eTestId.McpLogsEditConfigButton}-${CATALOG_ITEM_NAME}`,
    );
    await editConfigButton.click();

    // Wait for edit dialog to open
    const editDialog = adminPage.getByRole("dialog", {
      name: /Edit MCP Server/i,
    });
    await editDialog.waitFor({ state: "visible", timeout: 10000 });

    // Update the config to a valid MCP server that should start successfully
    const dockerImageInput = editDialog.getByRole("textbox", {
      name: "Docker Image",
    });
    await dockerImageInput.clear();
    await dockerImageInput.fill("");

    const commandInput = editDialog.getByRole("textbox", {
      name: "Command",
    });
    await commandInput.clear();
    await commandInput.fill("python");

    const argumentsInput = editDialog.getByRole("textbox", {
      name: "Arguments (one per line)",
    });
    await argumentsInput.clear();
    await argumentsInput.fill(`-c\n${PYTHON_MCP_SCRIPT}`);

    // Force manual reinstall by adding a prompted env var
    await editDialog.getByRole("button", { name: "Add Variable" }).click();
    await editDialog.getByPlaceholder("API_KEY").first().fill("E2E_PROMPT");
    await editDialog
      .getByTestId(E2eTestId.PromptOnInstallationCheckbox)
      .first()
      .click({ force: true });

    // Save changes
    await clickButton({ page: adminPage, options: { name: "Save Changes" } });
    await adminPage.waitForLoadState("networkidle");

    // Wait for edit dialog to close
    await editDialog.waitFor({ state: "hidden", timeout: 10000 });

    // ========================================
    // STEP 5: Click reinstall and wait for tools discovery
    // ========================================
    const reinstallButton = serverCard.getByRole("button", {
      name: "Reinstall Required",
    });
    await reinstallButton.waitFor({ state: "visible", timeout: 120_000 });
    await reinstallButton.click();

    const reinstallDialog = adminPage
      .getByRole("dialog")
      .filter({ hasText: /Reinstall -/ });
    await reinstallDialog.waitFor({ state: "visible", timeout: 30_000 });
    await reinstallDialog
      .getByRole("textbox", { name: "E2E_PROMPT" })
      .fill("ready");
    await clickButton({ page: adminPage, options: { name: "Reinstall" } });
    await reinstallDialog.waitFor({ state: "hidden", timeout: 30_000 });

    await expect(async () => {
      await goToPage(adminPage, "/mcp-catalog/registry");
      await adminPage.waitForLoadState("networkidle");

      const refreshedServerCard = adminPage.getByTestId(
        `${E2eTestId.McpServerCard}-${CATALOG_ITEM_NAME}`,
      );
      await refreshedServerCard.waitFor({ state: "visible", timeout: 30_000 });

      const refreshedErrorBanner = adminPage.getByTestId(
        `${E2eTestId.McpServerError}-${CATALOG_ITEM_NAME}`,
      );
      await expect(refreshedErrorBanner).not.toBeVisible({ timeout: 5000 });

      const manageToolsButton = adminPage.getByTestId(
        `${E2eTestId.ManageToolsButton}-${CATALOG_ITEM_NAME}`,
      );
      await expect(manageToolsButton).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 120_000, intervals: [3000, 5000, 7000, 10000] });

    // Cleanup
    await deleteCatalogItem(adminPage, extractCookieHeaders, CATALOG_ITEM_NAME);
  });
});

async function deleteCatalogItem(
  adminPage: Page,
  extractCookieHeaders: (page: Page) => Promise<string>,
  catalogItemName: string,
) {
  const cookieHeaders = await extractCookieHeaders(adminPage);
  await archestraApiSdk.deleteInternalMcpCatalogItemByName({
    path: { name: catalogItemName },
    headers: { Cookie: cookieHeaders },
  });
}

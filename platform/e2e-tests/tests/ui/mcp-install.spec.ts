import { expect } from "@playwright/test";
import { archestraApiSdk, E2eTestId } from "@shared";
import { goToPage, type Page, test } from "../../fixtures";
import { clickButton } from "../../utils";

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

  // TBD
  // test("Remote from catalog", () => {
  //   expect(true).toBe(true);
  // });

  test("Local server with advanced K8s configuration", async ({
    adminPage,
    extractCookieHeaders,
  }) => {
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

    // 5. Custom Labels (JSON editor) - Monaco requires click to focus then keyboard input
    const labelsEditorContainer = adminPage.locator(".monaco-editor").first();
    await labelsEditorContainer.click();
    await adminPage.keyboard.type(JSON.stringify(testConfig.labels));

    // 6. Custom Annotations (JSON editor)
    const annotationsEditorContainer = adminPage.locator(".monaco-editor").last();
    await annotationsEditorContainer.click();
    await adminPage.keyboard.type(JSON.stringify(testConfig.annotations));

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

    // Re-open the catalog item edit dialog to verify advanced K8s config was persisted
    // First, click the menu button (three-dots icon) on the server card
    await serverCard.locator("button").first().click();
    // Then click "Edit" in the dropdown menu
    await adminPage.getByRole("menuitem", { name: "Edit" }).click();
    await adminPage.waitForLoadState("networkidle");

    // Expand Advanced Configuration section
    const editAdvancedConfigButton = adminPage.getByRole("button", {
      name: /Advanced Configuration/,
    });
    await editAdvancedConfigButton.click();

    // Verify replicas value was saved
    const replicasInput = adminPage.getByRole("spinbutton", {
      name: "Replicas",
    });
    await expect(replicasInput).toHaveValue(String(testConfig.replicas));

    // Verify service account value was saved
    const serviceAccountInput = adminPage.getByRole("textbox", {
      name: "Service Account",
    });
    await expect(serviceAccountInput).toHaveValue(testConfig.serviceAccount);

    // Verify resource requests values were saved
    await expect(adminPage.getByPlaceholder("128Mi")).toHaveValue(
      testConfig.resourceRequestsMemory,
    );
    await expect(adminPage.getByPlaceholder("50m")).toHaveValue(
      testConfig.resourceRequestsCpu,
    );

    // Verify resource limits values were saved
    await expect(adminPage.getByPlaceholder("256Mi")).toHaveValue(
      testConfig.resourceLimitsMemory,
    );
    await expect(adminPage.getByPlaceholder("500m")).toHaveValue(
      testConfig.resourceLimitsCpu,
    );

    // Verify custom labels JSON was saved by checking the Monaco editor content
    const labelsEditorContent = await adminPage
      .locator(".monaco-editor")
      .first()
      .innerText();
    expect(labelsEditorContent).toContain("environment");
    expect(labelsEditorContent).toContain("e2e-test");

    // Verify custom annotations JSON was saved
    const annotationsEditorContent = await adminPage
      .locator(".monaco-editor")
      .last()
      .innerText();
    expect(annotationsEditorContent).toContain("app.kubernetes.io/managed-by");
    expect(annotationsEditorContent).toContain("archestra-e2e");

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

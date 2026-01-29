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

    await deleteCatalogItem(adminPage, extractCookieHeaders, CATALOG_ITEM_NAME);

    await goToPage(adminPage, "/mcp-catalog/registry");
    await adminPage.waitForLoadState("networkidle");

    // Open "Add MCP Server" dialog
    await clickButton({ page: adminPage, options: { name: "Add MCP Server" } });
    await adminPage.waitForLoadState("networkidle");

    // Click "Local (orchestrated by Archestra)" button
    await adminPage
      .getByRole("button", { name: "Local (orchestrated by Archestra)" })
      .click();

    // Fill basic fields
    await adminPage
      .getByRole("textbox", { name: "Name *" })
      .fill(CATALOG_ITEM_NAME);
    await adminPage
      .getByRole("textbox", { name: "Docker Image" })
      .fill("test-image:latest");
    await adminPage.getByRole("textbox", { name: "Command" }).fill("node");
    await adminPage
      .getByRole("textbox", { name: "Arguments (one per line)" })
      .fill("server.js");

    // Expand Advanced Configuration section
    const advancedConfigButton = adminPage.getByRole("button", {
      name: /Advanced Configuration/,
    });
    await advancedConfigButton.click();

    // Fill advanced K8s configuration fields
    await adminPage
      .getByRole("textbox", { name: "Replicas", exact: false })
      .fill("2");
    await adminPage
      .getByRole("textbox", { name: "Namespace" })
      .fill("custom-namespace");
    await adminPage
      .getByRole("textbox", { name: "Memory Request" })
      .fill("256Mi");
    await adminPage.getByRole("textbox", { name: "CPU Request" }).fill("100m");
    await adminPage
      .getByRole("textbox", { name: "Memory Limit" })
      .fill("512Mi");
    await adminPage.getByRole("textbox", { name: "CPU Limit" }).fill("500m");
    await adminPage
      .getByRole("textbox", { name: "Labels (JSON)" })
      .fill('{"environment": "test"}');
    await adminPage
      .getByRole("textbox", { name: "Annotations (JSON)" })
      .fill('{"app.kubernetes.io/managed-by": "archestra"}');

    // Add catalog item to the registry
    await clickButton({ page: adminPage, options: { name: "Add Server" } });
    await adminPage.waitForLoadState("networkidle");

    // Wait for the install dialog to be visible
    await adminPage
      .getByRole("dialog")
      .filter({ hasText: /Install -/ })
      .waitFor({ state: "visible", timeout: 30000 });

    // Close the install dialog without installing (just verifying catalog item was created)
    await adminPage.keyboard.press("Escape");
    await adminPage.waitForLoadState("networkidle");

    // Open the catalog item for editing to verify advanced K8s config was saved
    const serverCard = adminPage.getByTestId(
      `${E2eTestId.McpServerCard}-${CATALOG_ITEM_NAME}`,
    );
    await serverCard.waitFor({ state: "visible", timeout: 30000 });
    await serverCard.getByRole("button", { name: "Edit Server" }).click();
    await adminPage.waitForLoadState("networkidle");

    // Expand Advanced Configuration section
    const editAdvancedConfigButton = adminPage.getByRole("button", {
      name: /Advanced Configuration/,
    });
    await editAdvancedConfigButton.click();

    // Verify the advanced K8s configuration values were saved
    await adminPage
      .getByRole("textbox", { name: "Replicas", exact: false })
      .waitFor({ state: "visible" });

    // Verify replicas value
    const replicasInput = adminPage.getByRole("textbox", {
      name: "Replicas",
      exact: false,
    });
    await replicasInput.waitFor({ state: "visible" });

    // cleanup
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

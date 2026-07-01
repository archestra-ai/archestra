import { archestraApiSdk, E2eTestId } from "@archestra/shared";
import { expect } from "@playwright/test";
import { type Page, test } from "../fixtures";
import {
  clickButton,
  closeOpenDialogs,
  goToMcpRegistry,
  installMcpServer,
  openAddMcpServerDialog,
  submitAddServer,
  waitForInstallDialog,
  waitForMcpServerCard,
  waitForMcpServerToolsDiscovered,
} from "../utils";

/**
 * To cover:
 * - Custom self-hosted - out of scope because already tested in static-credentials-management.spec.ts
 * - Self-hosted from catalog
 * - Custom remote
 * - Remote from catalog
 */

test.describe("MCP Install", () => {
  test("Self-hosted from catalog", { tag: "@quickstart" }, async ({
    adminPage,
    extractCookieHeaders,
  }) => {
    const CONTEXT7_CATALOG_ITEM_NAME = "context7";

    await deleteCatalogItem(
      adminPage,
      extractCookieHeaders,
      CONTEXT7_CATALOG_ITEM_NAME,
    );

    await goToMcpRegistry(adminPage);

    // Open "Add MCP Server" dialog
    await openAddMcpServerDialog(adminPage);

    // Browse online catalog to search for context7
    await adminPage
      .getByRole("button", { name: "Select from Online Catalog" })
      .click();
    await adminPage.waitForLoadState("domcontentloaded");
    await adminPage
      .getByRole("textbox", { name: "Search servers by name..." })
      .fill("context7");
    await adminPage.waitForLoadState("domcontentloaded");
    // Timeout needed so filter is applied on UI
    await adminPage.waitForTimeout(3_000);

    // Click "Use as Template" to pre-fill the create form
    await adminPage.getByTestId(E2eTestId.AddCatalogItemButton).first().click();
    await adminPage.waitForLoadState("domcontentloaded");

    // Submit the pre-filled form to add server to registry
    await submitAddServer(adminPage);

    // Install dialog opens automatically after adding to registry
    // Wait for the install dialog to be visible
    await waitForInstallDialog(adminPage, { titlePattern: /Install -/ });

    // fill the api key (just fake value)
    await adminPage
      .getByRole("textbox", { name: "context7_api_key *" })
      .fill("fake-api-key");

    // install the server
    await installMcpServer(adminPage);

    // Wait for the card to appear in the registry after installation
    await waitForMcpServerCard(adminPage, CONTEXT7_CATALOG_ITEM_NAME);

    // Check that tools are discovered
    await waitForMcpServerToolsDiscovered(
      adminPage,
      CONTEXT7_CATALOG_ITEM_NAME,
    );

    // cleanup
    await deleteCatalogItem(
      adminPage,
      extractCookieHeaders,
      CONTEXT7_CATALOG_ITEM_NAME,
    );
  });

  test("Local server with bogus image shows error, logs, and can be fixed", async ({
    adminPage,
    extractCookieHeaders,
  }) => {
    // Re-skip pending fix to the underlying K8s pod-deletion race.
    // Skipped in #4848 (dcd211d55), unskipped in #4876 (2e2f8e328) under
    // the assumption it had stabilized, but it kept failing the merge
    // queue for unrelated PRs (most recently #4868). Re-skipping here so
    // #4868 can land; the race itself still needs a real fix.
    test.skip();
    // Increase timeout to 4 minutes to allow for K8s deployment attempts
    test.setTimeout(240_000);
    const CATALOG_ITEM_NAME = "e2e__bogus_image_test";
    const BOGUS_IMAGE = "image-that-doesnt-exist:123";
    // Flatten the script for `node -e`; literal newlines can be interpreted
    // differently when the command is passed through the container shell.
    const FIXED_MCP_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
setInterval(() => {}, 2147483647);
const tool = {
  name: "print_archestra_test",
  description: "E2E test tool",
  inputSchema: { type: "object", properties: {} },
};
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "e2e-fixed-server", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    send(message.id, { tools: [tool] });
    return;
  }
  if (message.method === "tools/call") {
    send(message.id, {
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    return;
  }
  send(message.id, {});
});
`.replace(/\n/g, " ");

    // Cleanup any existing catalog item
    await deleteCatalogItem(adminPage, extractCookieHeaders, CATALOG_ITEM_NAME);

    await goToMcpRegistry(adminPage);

    // ========================================
    // STEP 1: Create MCP server with bogus image
    // ========================================
    await clickButton({ page: adminPage, options: { name: "Add MCP Server" } });
    await adminPage.waitForLoadState("domcontentloaded");

    await adminPage
      .getByRole("button", {
        name: "Self-hosted",
      })
      .click();

    // Fill basic fields with bogus image
    await adminPage
      .getByRole("textbox", { name: "Name *" })
      .fill(CATALOG_ITEM_NAME);
    await adminPage
      .getByRole("textbox", { name: "Image (optional)" })
      .fill(BOGUS_IMAGE);
    await adminPage.getByRole("textbox", { name: "Command" }).fill("sleep");
    await adminPage
      .getByRole("textbox", { name: "Arguments (one per line)" })
      .fill("infinity");

    // Add catalog item to registry
    await clickButton({ page: adminPage, options: { name: "Add Server" } });
    await adminPage.waitForLoadState("domcontentloaded");

    // Wait for install dialog and install the server
    await adminPage
      .getByRole("dialog")
      .filter({ hasText: /Install -/ })
      .waitFor({ state: "visible", timeout: 30000 });
    await clickButton({ page: adminPage, options: { name: "Install" } });
    await adminPage.waitForLoadState("domcontentloaded");

    // Wait for the server card to appear
    const serverCard = adminPage.getByTestId(
      `${E2eTestId.McpServerCard}-${CATALOG_ITEM_NAME}`,
    );
    await serverCard.waitFor({ state: "visible", timeout: 30000 });

    // ========================================
    // STEP 2: Wait for failure status (error banner)
    // ========================================
    const cookieHeaders = await extractCookieHeaders(adminPage);
    await expect
      .poll(
        async () => {
          const response = await archestraApiSdk.getMcpServers({
            headers: { Cookie: cookieHeaders },
          });
          if (response.error) {
            return null;
          }
          return (
            response.data?.find(
              (server) =>
                server.catalogName === CATALOG_ITEM_NAME ||
                server.name.startsWith(`${CATALOG_ITEM_NAME}-`),
            )?.localInstallationStatus ?? null
          );
        },
        { timeout: 120_000, intervals: [1000, 2000, 5000] },
      )
      .toBe("error");

    await adminPage.reload();
    await adminPage.waitForLoadState("domcontentloaded");

    const errorBanner = adminPage.getByTestId(
      `${E2eTestId.McpServerError}-${CATALOG_ITEM_NAME}-default`,
    );
    await errorBanner.waitFor({ state: "visible", timeout: 30_000 });

    // ========================================
    // STEP 3: Check logs show deployment events
    // ========================================
    // Click "view the logs" link in the error banner
    const viewLogsButton = adminPage.getByTestId(
      `${E2eTestId.McpLogsViewButton}-${CATALOG_ITEM_NAME}-default`,
    );
    await viewLogsButton.click();

    // Wait for logs content to appear inside the settings dialog
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

    // Close the settings dialog
    await adminPage.keyboard.press("Escape");
    await logsContent.waitFor({ state: "hidden", timeout: 5000 });

    // ========================================
    // STEP 4: Edit config to fix the image
    // ========================================
    // Click "edit your config" link in the error banner (opens settings dialog to Configuration page)
    const editConfigButton = adminPage.getByTestId(
      `${E2eTestId.McpLogsEditConfigButton}-${CATALOG_ITEM_NAME}-default`,
    );
    await editConfigButton.click();

    // Wait for the settings dialog Configuration page to load
    const settingsDialog = adminPage.getByRole("dialog", {
      name: `${CATALOG_ITEM_NAME} Settings`,
    });
    await settingsDialog.waitFor({ state: "visible", timeout: 10000 });

    // Update the config to a valid MCP server that should start successfully
    const dockerImageInput = settingsDialog.getByRole("textbox", {
      name: "Image (optional)",
    });
    await dockerImageInput.clear();
    await dockerImageInput.fill("");

    const commandInput = settingsDialog.getByRole("textbox", {
      name: "Command",
    });
    await commandInput.clear();
    await commandInput.fill("node");

    await settingsDialog.getByLabel("stdio").click();

    const argumentsInput = settingsDialog.getByRole("textbox", {
      name: "Arguments (one per line)",
    });
    await argumentsInput.clear();
    await argumentsInput.fill(`-e\n${FIXED_MCP_SCRIPT}`);

    // Force manual reinstall by adding a prompted env var.
    // Since #4696, the "Add Variable" button opens its own sub-dialog
    // ("Add environment variable") and all env-var inputs scope to it.
    // The new scope dropdown defaults to "Prompt at installation" — which
    // is exactly what this test wants to force a manual reinstall — so we
    // only need to fill the key and confirm; no scope toggle required.
    await settingsDialog.getByRole("button", { name: "Add Variable" }).click();
    const envVarDialog = adminPage.getByRole("dialog", {
      name: /Add environment variable/i,
    });
    await envVarDialog.waitFor({ state: "visible", timeout: 15_000 });
    await envVarDialog.getByRole("textbox", { name: "Key" }).fill("E2E_PROMPT");
    await envVarDialog.getByRole("button", { name: "Add variable" }).click();
    await envVarDialog.waitFor({ state: "hidden", timeout: 15_000 });

    // Save changes (dialog stays open with keepOpenOnSave). The form's
    // footer transforms into an inline confirm bar when the save would
    // cascade — same surface, no stacked dialog. The CTA matches the
    // backend path: this edit (command + prompted env var) takes the
    // manual reinstall path, so the button is "Save and mark for
    // reinstall". An auto-path edit would show "Save and reinstall"
    // instead — match either to keep the test robust.
    await clickButton({ page: adminPage, options: { name: "Save Changes" } });
    const confirmReinstallButton = settingsDialog.getByRole("button", {
      name: /Save and (mark for )?reinstall/,
    });
    if (await confirmReinstallButton.isVisible().catch(() => false)) {
      await confirmReinstallButton.click();
      await confirmReinstallButton.waitFor({
        state: "hidden",
        timeout: 15_000,
      });
    }
    await adminPage.waitForLoadState("domcontentloaded");

    // ========================================
    // STEP 5: Click install/reinstall and wait for tools discovery
    // ========================================
    // Reinstall from the settings dialog. Failed local installations do not
    // expose a card-level install action while the personal connection exists.
    const reinstallActionButton = settingsDialog.getByRole("button", {
      name: "Reinstall",
    });
    await reinstallActionButton.waitFor({ state: "visible", timeout: 120_000 });
    await reinstallActionButton.click();

    // The install dialog opens with prompted env vars
    const reinstallDialog = adminPage
      .getByRole("dialog")
      .filter({ hasText: /(Install|Reinstall) -/ });
    await reinstallDialog.waitFor({ state: "visible", timeout: 30_000 });
    await reinstallDialog
      .getByRole("textbox", { name: "E2E_PROMPT" })
      .fill("ready");
    await reinstallDialog
      .getByRole("button", { name: /^(Install|Reinstall)$/ })
      .click();
    await reinstallDialog.waitFor({ state: "hidden", timeout: 30_000 });
    await closeOpenDialogs(adminPage, { timeoutMs: 10_000 });
    await expect(settingsDialog).not.toBeVisible({ timeout: 10_000 });

    await expect(async () => {
      await goToMcpRegistry(adminPage);

      const refreshedServerCard = adminPage.getByTestId(
        `${E2eTestId.McpServerCard}-${CATALOG_ITEM_NAME}`,
      );
      await refreshedServerCard.waitFor({ state: "visible", timeout: 30_000 });

      const refreshedErrorBanner = adminPage.getByTestId(
        `${E2eTestId.McpServerError}-${CATALOG_ITEM_NAME}-default`,
      );
      await expect(refreshedErrorBanner).not.toBeVisible({ timeout: 5000 });

      // Check that tools are discovered (tools count is visible on the card)
      const toolsCount = refreshedServerCard.getByTestId(
        E2eTestId.McpServerToolsCount,
      );
      await expect(toolsCount).toBeVisible({ timeout: 5000 });
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

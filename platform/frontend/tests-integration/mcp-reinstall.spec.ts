import { makeCatalogItem } from "../src/mocks/data/catalog";
import { makeInstalledServer } from "../src/mocks/data/servers";
import { expect, test } from "./fixtures";

test.describe("Reinstall remote MCP server", () => {
  test("new required header on a remote catalog: Reinstall opens an input dialog for the missing value", async ({
    page,
    mcpRegistryPage,
    mswControl,
  }) => {
    const remoteCatalog = makeCatalogItem({
      id: "test-remote-with-header",
      name: "test-remote-with-header",
      serverType: "remote",
      serverUrl: "https://example.test/mcp",
      userConfig: {
        header_x_api_key: {
          type: "string",
          title: "X-API-Key",
          description: "Newly-required header (added in a catalog edit)",
          promptOnInstallation: true,
          required: true,
          sensitive: true,
          headerName: "X-API-Key",
        },
      },
      toolCount: 1,
    });
    const flaggedInstall = makeInstalledServer({
      id: "test-server-remote-flagged",
      name: "test-remote-with-header",
      catalogId: remoteCatalog.id,
      serverType: "remote",
      scope: "personal",
      reinstallRequired: true,
      // McpServerCard.isCurrentUserAuthenticated reads from `users`.
      users: ["test-user-admin"],
    });

    await mswControl.use({
      method: "get",
      url: "/api/internal_mcp_catalog",
      body: [remoteCatalog],
    });
    await mswControl.use({
      method: "get",
      url: "/api/mcp_server",
      body: [flaggedInstall],
    });
    await mswControl.use({
      method: "post",
      url: "/api/mcp_server/:id/reinstall",
      body: {
        ...flaggedInstall,
        reinstallRequired: false,
        localInstallationStatus: "pending",
      },
    });

    await mcpRegistryPage.goto();
    await expect(mcpRegistryPage.heading).toBeVisible();
    await expect(
      mcpRegistryPage.cardForCatalogItem(remoteCatalog.name),
    ).toBeVisible();

    await page.getByRole("button", { name: "Reinstall" }).click();

    // Regression: the bug opened a plain confirmation modal here, with no
    // input for the newly-required header.
    const dialog = page
      .getByRole("dialog")
      .filter({ hasText: /Reinstall Server/ });
    await expect(dialog).toBeVisible();

    const headerField = dialog.getByRole("textbox", { name: /X-API-Key/i });
    await expect(headerField).toBeVisible();
    await headerField.fill("fresh-header-value");

    await dialog.getByRole("button", { name: "Reinstall" }).click();
    await expect(dialog).toBeHidden();
  });
});

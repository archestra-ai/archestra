import { makeCatalogItem } from "../src/mocks/data/catalog";
import { makeInstalledServer } from "../src/mocks/data/servers";
import { expect, test } from "./fixtures";

test.describe("Add Remote MCP Server", () => {
  test("no-auth remote: create + install reports a working connection", async ({
    page,
    mcpRegistryPage,
    mswControl,
  }) => {
    const newCatalogItem = makeCatalogItem({
      id: "test-remote-no-auth",
      name: "test-remote-noauth",
      serverType: "remote",
      multitenant: true,
      requiresAuth: false,
      serverUrl: "https://example.test/mcp",
      toolCount: 3,
    });
    const installedServer = makeInstalledServer({
      id: "test-server-remote",
      name: "test-remote-noauth",
      catalogId: newCatalogItem.id,
      serverType: "remote",
      localInstallationStatus: "success",
    });

    await mcpRegistryPage.goto();
    await expect(mcpRegistryPage.heading).toBeVisible();

    await mswControl.use({
      method: "post",
      url: "/api/internal_mcp_catalog",
      body: newCatalogItem,
    });
    // Creating the item routes to /mcp/registry/:id/edit?step=test, which
    // resolves the item from the catalog list.
    await mswControl.use({
      method: "get",
      url: "/api/internal_mcp_catalog",
      body: [newCatalogItem],
    });
    await mswControl.use({
      method: "post",
      url: "/api/mcp_server",
      body: installedServer,
    });

    await page.getByRole("button", { name: "Add MCP Server" }).click();
    await page.getByRole("button", { name: "Start from scratch" }).click();
    await page.getByRole("button", { name: /^Remote/ }).click();

    await page
      .getByRole("textbox", { name: "Name *" })
      .fill("test-remote-noauth");
    await page
      .getByRole("textbox", { name: "Server URL *" })
      .fill("https://example.test/mcp");

    await page.getByRole("button", { name: "Add Server" }).click();

    // Creating the item continues on the setup wizard's "Test connection"
    // step. Its Install button installs a no-auth remote directly (no
    // dialog), then refetches the servers list — which now reports the
    // successful connection.
    const installButton = page.getByRole("button", {
      name: "Install",
      exact: true,
    });
    await expect(installButton).toBeVisible();
    await mswControl.use({
      method: "get",
      url: "/api/mcp_server",
      body: [installedServer],
    });

    // Retry the click: a click landing before React attaches the handler is
    // silently lost (same next-dev quirk skill-share.spec works around).
    // Installing is idempotent against the mocked POST, so re-clicking is safe.
    await expect(async () => {
      await installButton.click();
      await expect(page.getByText("Connected", { exact: true })).toBeVisible({
        timeout: 3_000,
      });
    }).toPass({ timeout: 30_000 });
  });

  test("bearer-token remote: install failure surfaces the connection error", async ({
    page,
    mcpRegistryPage,
    mswControl,
  }) => {
    const newCatalogItem = makeCatalogItem({
      id: "test-remote-bearer",
      name: "test-remote-bearer",
      serverType: "remote",
      multitenant: true,
      requiresAuth: true,
      serverUrl: "https://example.test/mcp",
      toolCount: 0,
      // The bearer-auth picker writes this userConfig shape; the install
      // dialog reads it to render the "Access Token *" input. See
      // mcp-catalog-form.utils.ts buildUserConfigForAuth().
      userConfig: {
        access_token: {
          type: "string",
          title: "Access Token",
          description: "Token for authentication",
          required: true,
          sensitive: true,
        },
      },
    });

    await mcpRegistryPage.goto();
    await expect(mcpRegistryPage.heading).toBeVisible();

    await mswControl.use({
      method: "post",
      url: "/api/internal_mcp_catalog",
      body: newCatalogItem,
    });
    // Creating the item routes to /mcp/registry/:id/edit?step=test, which
    // resolves the item from the catalog list.
    await mswControl.use({
      method: "get",
      url: "/api/internal_mcp_catalog",
      body: [newCatalogItem],
    });
    await mswControl.use({
      method: "post",
      url: "/api/mcp_server",
      status: 400,
      body: {
        error: {
          message: "Failed to connect to MCP server",
          type: "api_internal_server_error",
        },
      },
    });

    await page.getByRole("button", { name: "Add MCP Server" }).click();
    await page.getByRole("button", { name: "Start from scratch" }).click();
    await page.getByRole("button", { name: /^Remote/ }).click();

    await page
      .getByRole("textbox", { name: "Name *" })
      .fill("test-remote-bearer");
    await page
      .getByRole("textbox", { name: "Server URL *" })
      .fill("https://example.test/mcp");
    // The auth picker is rendered as buttons (was a radio in older versions);
    // "Token header" selects bearer-token auth.
    await page.getByRole("button", { name: /Token header/ }).click();

    await page.getByRole("button", { name: "Add Server" }).click();

    // The setup wizard's "Test connection" step opens the install dialog to
    // collect the token (the item has promptable userConfig). Retry the
    // click: a click landing before React attaches the handler is silently
    // lost (same next-dev quirk skill-share.spec works around). "Install" is
    // matched exactly — the form's auth/env labels contain "installation".
    const installDialog = page
      .getByRole("dialog")
      .filter({ hasText: /Install Server/ });
    const stepInstallButton = page.getByRole("button", {
      name: "Install",
      exact: true,
    });
    await expect(stepInstallButton).toBeVisible();
    await expect(async () => {
      await stepInstallButton.click();
      await expect(installDialog).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });

    await installDialog
      .getByRole("textbox", { name: "Access Token *" })
      .fill("fake-token");

    await installDialog.getByRole("button", { name: "Install" }).click();

    await expect(
      page.getByText(/Failed to connect to MCP server/).first(),
    ).toBeVisible();
  });
});

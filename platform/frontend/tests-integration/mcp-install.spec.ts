import { makeCatalogItem } from "../src/mocks/data/catalog";
import { makeInstalledServer } from "../src/mocks/data/servers";
import { expect, test } from "./fixtures";

test.describe("Add Remote MCP Server (mocked backend)", () => {
  test("no-auth remote: create + install shows the success toast", async ({
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

    await mcpRegistryPage.goto();
    await expect(mcpRegistryPage.heading).toBeVisible();

    await mswControl.use({
      method: "post",
      url: "/api/internal_mcp_catalog",
      body: newCatalogItem,
    });
    await mswControl.use({
      method: "post",
      url: "/api/mcp_server",
      body: makeInstalledServer({
        id: "test-server-remote",
        name: "test-remote-noauth",
        catalogId: newCatalogItem.id,
        serverType: "remote",
        localInstallationStatus: "success",
      }),
    });

    await page.getByRole("button", { name: "Add MCP Server" }).click();
    await page.getByRole("button", { name: /^Remote/ }).click();

    await page
      .getByRole("textbox", { name: "Name *" })
      .fill("test-remote-noauth");
    await page
      .getByRole("textbox", { name: "Server URL *" })
      .fill("https://example.test/mcp");

    await page.getByRole("button", { name: "Add Server" }).click();

    const installDialog = page
      .getByRole("dialog")
      .filter({ hasText: /Install Server/ });
    await expect(installDialog).toBeVisible();

    await installDialog.getByRole("button", { name: "Install" }).click();

    // Sonner toast fired by useInstallMcpServer's onSuccess
    // ("Successfully installed test-remote-noauth").
    await expect(
      page.getByText(/Successfully installed test-remote-noauth/),
    ).toBeVisible();
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

    const installDialog = page
      .getByRole("dialog")
      .filter({ hasText: /Install Server/ });
    await expect(installDialog).toBeVisible();

    await installDialog
      .getByRole("textbox", { name: "Access Token *" })
      .fill("fake-token");

    await installDialog.getByRole("button", { name: "Install" }).click();

    await expect(
      page.getByText(/Failed to connect to MCP server/).first(),
    ).toBeVisible();
  });
});

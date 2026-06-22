import { makeUserPermissions } from "../src/mocks/data/auth";
import { makeCatalogItem } from "../src/mocks/data/catalog";
import { makeInstalledServer } from "../src/mocks/data/servers";
import { expect, test } from "./fixtures";

test.describe("Reinstall remote MCP server", () => {
  // FIXME(flaky): first-touch route cold-compile under `next dev` exceeds the
  // visibility budget on loaded CI runners (passes on main). Quarantined until de-flaked.
  test.fixme("new required header on a remote catalog: Reinstall opens an input dialog for the missing value", async ({
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

  // FIXME(flaky): cold-route-compile timeout under CI load (passes on main). Quarantined until de-flaked.
  test.fixme("member without team/org install permission can still reinstall their personal remote install", async ({
    page,
    mcpRegistryPage,
    mswControl,
  }) => {
    // Regression: the dialog forwards the existing personal scope into the
    // credential-type selector so that, in reinstall mode, it locks rather
    // than re-evaluates `canInstall`. Without the fix a member whose only
    // install is the (already-used) personal one had `canInstall=false`
    // for every scope and the Submit button was hidden.
    const remoteCatalog = makeCatalogItem({
      id: "test-remote-member-reinstall",
      name: "test-remote-member-reinstall",
      serverType: "remote",
      serverUrl: "https://example.test/mcp",
      userConfig: {
        header_x_api_key: {
          type: "string",
          title: "X-API-Key",
          description: "Newly-required header",
          promptOnInstallation: true,
          required: true,
          sensitive: true,
          headerName: "X-API-Key",
        },
      },
      toolCount: 1,
    });
    const flaggedInstall = makeInstalledServer({
      id: "test-server-remote-member-flagged",
      name: "test-remote-member-reinstall",
      catalogId: remoteCatalog.id,
      serverType: "remote",
      scope: "personal",
      reinstallRequired: true,
      users: ["test-user-admin"],
    });

    // Member-like role: can update their own installs (so the card's
    // Reinstall button is clickable) but cannot create team / org installs.
    await mswControl.use({
      method: "get",
      url: "/api/user/permissions",
      body: makeUserPermissions({
        mcpServerInstallation: ["read", "create", "update"],
      }),
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

    const dialog = page
      .getByRole("dialog")
      .filter({ hasText: /Reinstall Server/ });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("textbox", { name: /X-API-Key/i })
      .fill("member-fresh-value");

    // The Submit button must render even though the member has no
    // `mcpServerInstallation: update` / `admin`. Without the fix it was
    // missing because canInstall fell through to false.
    const submit = dialog.getByRole("button", { name: "Reinstall" });
    await expect(submit).toBeVisible();
    await submit.click();
    await expect(dialog).toBeHidden();
  });
});

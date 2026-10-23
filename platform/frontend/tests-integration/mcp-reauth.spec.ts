import { makeCatalogItem } from "../src/mocks/data/catalog";
import { makeInstalledServer } from "../src/mocks/data/servers";
import { expect, test } from "./fixtures";

for (const scope of ["personal", "team", "org"] as const) {
  test(`reauthentication link keeps the existing ${scope} connection`, async ({
    page,
    mswControl,
    baseURL,
  }) => {
    const catalog = makeCatalogItem({
      id: "test-oauth-catalog",
      name: "Review Tools",
      serverType: "remote",
      serverUrl: "https://example.test/mcp",
      requiresAuth: true,
      oauthConfig: {
        name: "review-tools",
        server_url: "https://example.test/mcp",
        client_id: "test-client",
        redirect_uris: ["https://example.test/callback"],
        scopes: ["read"],
        default_scopes: ["read"],
        supports_resource_metadata: false,
        authorization_endpoint: "https://example.test/authorize",
        token_endpoint: "https://example.test/token",
      },
    });
    const server = makeInstalledServer({
      id: "test-expired-connection",
      catalogId: catalog.id,
      name: catalog.name,
      serverType: "remote",
      scope,
      teamId: scope === "team" ? "test-team" : null,
    });
    const providerUrl = `${baseURL}/internal-test/reauth-provider`;
    await page.route(providerUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "Authorization reached",
      }),
    );
    await mswControl.registerMany([
      { method: "get", url: "/api/internal_mcp_catalog", body: [catalog] },
      { method: "get", url: "/api/mcp_server", body: [server] },
      {
        method: "post",
        url: "/api/oauth/initiate",
        body: { authorizationUrl: providerUrl, state: "test-state" },
      },
    ]);
    await page.goto(`/mcp/registry?reauth=${catalog.id}&server=${server.id}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/re-authorize your existing/)).toBeVisible();
    await expect(dialog.getByRole("combobox")).toHaveCount(0);
    await dialog
      .getByRole("button", { name: /Continue to Authorization/ })
      .click();
    await expect(page).toHaveURL(providerUrl);
    // The callback uses this context to update the same connection instead
    // of creating a replacement or changing who can use it.
    expect(
      await page.evaluate(() => ({
        server: sessionStorage.getItem("oauth_mcp_server_id"),
        scope: sessionStorage.getItem("oauth_scope"),
        team: sessionStorage.getItem("oauth_team_id"),
      })),
    ).toEqual({ server: server.id, scope, team: server.teamId });
  });
}

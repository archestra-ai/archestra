import { expect } from "@playwright/test";
import { makeInstalledServer } from "../src/mocks/data/servers";
import { test } from "./fixtures";

for (const expectedState of [null, "another-tab-state"]) {
  test(`does not exchange a callback without matching tab state (${expectedState})`, async ({
    page,
  }) => {
    await page.addInitScript((state) => {
      if (state) sessionStorage.setItem("oauth_state", state);
    }, expectedState);
    const exchanges: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/oauth/callback") {
        exchanges.push(request.url());
      }
    });

    await page.goto(
      "/oauth-callback?code=synthetic-code&state=synthetic-state",
    );

    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "This authorization does not match the connection started in this tab.",
    );
    expect(exchanges).toEqual([]);
  });
}

test("matching state completes the callback and installs the returned credential", async ({
  page,
  mswControl,
}) => {
  const server = makeInstalledServer({
    serverType: "remote",
    oauthRefreshError: undefined,
  });
  await mswControl.use({
    method: "post",
    url: "/api/oauth/callback",
    body: {
      success: true,
      catalogId: server.catalogId,
      name: server.name,
      secretId: "synthetic-secret-reference",
      accessToken: "synthetic-access-token",
    },
  });
  await mswControl.use({
    method: "post",
    url: "/api/mcp_server",
    body: server,
  });
  // Start in the registry, as the real flow does, so the return page is ready.
  await page.goto("/mcp/registry");
  await expect(
    page.getByRole("heading", { name: "MCP Registry", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    sessionStorage.setItem("oauth_state", "synthetic-state");
    sessionStorage.setItem("oauth_scope", "personal");
  });
  const callback = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/oauth/callback" &&
      request.method() === "POST",
  );
  const install = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/mcp_server" &&
      request.method() === "POST",
  );

  await page.goto(
    "/oauth-callback?code=synthetic-code&state=synthetic-state&iss=https%3A%2F%2Fauth.example.com",
  );

  expect((await callback).postDataJSON()).toEqual({
    code: "synthetic-code",
    state: "synthetic-state",
    iss: "https://auth.example.com",
  });
  expect((await install).postDataJSON()).toMatchObject({
    catalogId: server.catalogId,
    secretId: "synthetic-secret-reference",
    scope: "personal",
  });
  await expect(page).toHaveURL(/\/mcp\/registry/);
  expect(await page.evaluate(() => sessionStorage.getItem("oauth_state"))).toBe(
    null,
  );
});

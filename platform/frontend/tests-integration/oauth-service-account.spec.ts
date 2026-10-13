import { adminPermissionsSeed } from "../src/mocks/data/auth";
import { expect, test } from "./fixtures";

// The mock boundary keeps this browser regression independent of live stacks.
test("binds an OAuth client to a service account and persists the selection", async ({
  page,
  mswControl,
}, testInfo) => {
  const accountId = "1bf3105a-14bb-4b36-895c-2140064f5de0";
  const gatewayId = "35069320-0405-4ad3-a796-92a9b5ea091d";
  const client = {
    id: "097fcbb8-41e8-4dd5-857b-d008c58bc824",
    clientId: "automation-client",
    name: "Automation client",
    organizationId: "test-org",
    grantType: "client_credentials",
    allowedGatewayIds: [gatewayId],
    redirectUris: [],
    disabled: false,
    authorId: "test-user-id",
    authorName: null,
    createdBy: null,
    labels: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    serviceAccountId: null,
  };
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/user/permissions",
      body: {
        ...adminPermissionsSeed,
        serviceAccount: ["read", "create", "update", "delete"],
      },
    },
    { method: "get", url: "/api/mcp-oauth-clients", body: [client] },
    {
      method: "get",
      url: "/api/agents/all",
      body: [
        { id: gatewayId, name: "Automation gateway", agentType: "mcp_gateway" },
      ],
    },
    {
      method: "get",
      url: "/api/service-accounts",
      body: [
        {
          id: accountId,
          name: "Automation account",
          role: "member",
          disabled: false,
        },
      ],
    },
    {
      method: "put",
      url: `/api/mcp-oauth-clients/${client.id}`,
      body: { ...client, serviceAccountId: accountId },
    },
  ]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/settings/oauth-clients");
  await page.getByText(client.name, { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: client.name });
  await dialog
    .getByRole("combobox", { name: "Act as service account" })
    .click();
  await page
    .getByRole("option", { name: "Automation account", exact: true })
    .click();
  await expect(
    dialog.getByRole("combobox", { name: "Act as service account" }),
  ).toContainText("Automation account");
  const submitted = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().endsWith(`/api/mcp-oauth-clients/${client.id}`),
  );
  await dialog
    .getByRole("button", { name: "Save Changes", exact: true })
    .click();
  expect((await submitted).postDataJSON()).toMatchObject({
    serviceAccountId: accountId,
  });
  await expect(dialog).not.toBeVisible();
  await mswControl.use({
    method: "get",
    url: "/api/mcp-oauth-clients",
    body: [{ ...client, serviceAccountId: accountId }],
  });
  await page.reload();
  await page.getByText(client.name, { exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("combobox", { name: "Act as service account" }),
  ).toContainText("Automation account");
  await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("oauth-service-account.png"),
    fullPage: true,
  });
});

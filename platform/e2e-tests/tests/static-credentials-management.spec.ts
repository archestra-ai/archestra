import type { Page } from "@playwright/test";
import { archestraApiSdk } from "@shared";
import {
  ADMIN_EMAIL,
  DEFAULT_TEAM_NAME,
  E2eTestId,
  EDITOR_EMAIL,
  ENGINEERING_TEAM_NAME,
  MARKETING_TEAM_NAME,
} from "../consts";
import { expect, goToPage, test } from "../fixtures";
import {
  addCustomSelfHostedCatalogItem,
  addSharedLocalConnection,
  assignCatalogCredentialToGateway,
  clickButton,
  closeOpenDialogs,
  createSharedTestGatewayViaApi,
  createTeamMcpGatewayViaApi,
  getVisibleCredentials,
  getVisibleStaticCredentials,
  goToMcpRegistry,
  installLocalCatalogItem,
  openGatewayCatalogToolAssignment,
  openManageCredentialsDialog,
  saveOpenProfileDialog,
  settleRegistryAfterInstall,
  verifyToolCallResultViaApi,
  waitForMcpServerToolsDiscovered,
} from "../utils";

test.describe.configure({ mode: "serial" });

test.describe("Custom Self-hosted MCP Server - installation and static credentials management (vault disabled, prompt-on-installation disabled)", () => {
  // Matrix tests
  const MATRIX: { user: "Admin" | "Editor" | "Member" }[] = [
    {
      user: "Admin",
    },
    {
      user: "Editor",
    },
    {
      user: "Member",
    },
  ];
  MATRIX.forEach(({ user }) => {
    test(`${user}`, async ({
      adminPage,
      editorPage,
      memberPage,
      extractCookieHeaders,
      makeRandomString,
    }) => {
      test.setTimeout(60_000); // 60 seconds - k8s pod startup can be slow
      const page = (() => {
        switch (user) {
          case "Admin":
            return adminPage;
          case "Editor":
            return editorPage;
          case "Member":
            return memberPage;
        }
      })();
      const cookieHeaders = await extractCookieHeaders(adminPage);
      const pageCookieHeaders = await extractCookieHeaders(page);
      const catalogItemName = makeRandomString(10, "mcp");
      let adminSharedGateway: { id: string; name: string } | undefined;
      if (user === "Admin") {
        adminSharedGateway = await createSharedTestGatewayViaApi({
          cookieHeaders,
          gatewayName: makeRandomString(10, "shared-gw"),
        });
      }

      // Create catalog item as Admin
      // Editor and Member cannot add items to MCP Registry
      let newCatalogItem: { id: string; name: string } | undefined;
      newCatalogItem = await addCustomSelfHostedCatalogItem({
        page: adminPage,
        cookieHeaders,
        catalogItemName,
        scope: "org",
      });

      await goToMcpRegistry(page);
      await installLocalCatalogItem({ page, catalogItemName });
      await settleRegistryAfterInstall(page);

      if (user === "Member") {
        await openManageCredentialsDialog(page, catalogItemName);
        await expect(
          page.getByTestId(
            E2eTestId.ManageCredentialsSharedConnectionsEmptyState,
          ),
        ).toBeVisible();
        await closeOpenDialogs(page);
      } else {
        const expectedTeams = {
          Admin: [
            DEFAULT_TEAM_NAME,
            ENGINEERING_TEAM_NAME,
            MARKETING_TEAM_NAME,
          ],
          Editor: [ENGINEERING_TEAM_NAME, MARKETING_TEAM_NAME],
        };
        const teamsResponse = await archestraApiSdk.getTeams({
          headers: { Cookie: pageCookieHeaders },
        });
        if (teamsResponse.error) {
          throw new Error(
            `Failed to get teams for ${user}: ${JSON.stringify(teamsResponse.error)}`,
          );
        }
        const teamId = teamsResponse.data?.data.find(
          (team) => team.name === expectedTeams[user][0],
        )?.id;
        if (!teamId) {
          throw new Error(
            `Team "${expectedTeams[user][0]}" not found for ${user}`,
          );
        }
        const installResponse = await archestraApiSdk.installMcpServer({
          headers: { Cookie: pageCookieHeaders },
          body: {
            name: catalogItemName,
            catalogId: newCatalogItem.id,
            scope: "team",
            teamId,
          },
        });
        if (installResponse.error) {
          throw new Error(
            `Failed to install shared connection for ${user}: ${JSON.stringify(installResponse.error)}`,
          );
        }
        await settleRegistryAfterInstall(page);
        await waitForMcpServerToolsDiscovered(page, catalogItemName);
      }

      // Check Manage Credentials dialog
      // All users can see Manage Credentials button and open the dialog
      // Members see only their personal and team credentials they have access to
      const visibleServersResponse = await archestraApiSdk.getMcpServers({
        headers: { Cookie: pageCookieHeaders },
      });
      if (visibleServersResponse.error) {
        throw new Error(
          `Failed to get visible MCP servers for ${user}: ${JSON.stringify(visibleServersResponse.error)}`,
        );
      }
      const expectedCredentials =
        visibleServersResponse.data
          ?.filter((server) => server.catalogId === newCatalogItem.id)
          .map(
            (server) =>
              server.teamDetails?.name ?? server.ownerEmail ?? "Deleted user",
          ) ?? [];
      await openManageCredentialsDialog(page, catalogItemName);
      const connectionsButton = page
        .getByRole("dialog")
        .filter({ visible: true })
        .last()
        .getByRole("button", { name: /^Connections\b/ });
      await expect(connectionsButton).toBeVisible();
      await closeOpenDialogs(page);

      if (user !== "Member") {
        // Editor can't see org-scoped gateways, so create a team-scoped one
        let teamGateway: { id: string; name: string } | undefined;
        if (user === "Editor") {
          teamGateway = await createTeamMcpGatewayViaApi({
            cookieHeaders,
            teamName: ENGINEERING_TEAM_NAME,
            gatewayName: makeRandomString(10, "gw"),
          });
        }

        // Check TokenSelect shows correct credentials
        const gatewayNameForAssignment =
          teamGateway?.name ?? adminSharedGateway?.name;
        if (!gatewayNameForAssignment) {
          throw new Error(
            `Expected a gateway for ${user} but none was provisioned`,
          );
        }
        await openGatewayCatalogToolAssignment({
          page,
          catalogItemName,
          gatewayName: gatewayNameForAssignment,
        });
        const expectedAssignableCredentials = expectedCredentials;
        const visibleStaticCredentials =
          await getVisibleStaticCredentials(page);
        for (const credential of expectedAssignableCredentials) {
          await expect(visibleStaticCredentials).toContain(credential);
        }
        await expect(visibleStaticCredentials).toHaveLength(
          expectedAssignableCredentials.length,
        );
        await page
          .getByRole("option", {
            name: expectedAssignableCredentials[0] ?? "",
          })
          .click();
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
        await saveOpenProfileDialog(page);

        // Then we revoke first credential in Manage Credentials dialog, then close dialog
        await goToPage(page, "/mcp/registry");
        await openManageCredentialsDialog(page, catalogItemName);
        await clickButton({ page, options: { name: "Revoke" }, first: true });
        await page.waitForLoadState("domcontentloaded");
        await closeOpenDialogs(page);

        // And we check that the credential is revoked
        // Use polling to handle async credential revocation in CI
        const expectedCredentialsAfterRevoke = {
          Admin: [ADMIN_EMAIL, DEFAULT_TEAM_NAME],
          Editor: [EDITOR_EMAIL, ENGINEERING_TEAM_NAME],
        };
        const revokedCredential = expectedCredentialsAfterRevoke[user][0];
        const remainingCredential =
          expectedCredentialsAfterRevoke[user][1] ?? null;

        await expect(async () => {
          await goToPage(page, "/mcp/registry");
          await openManageCredentialsDialog(page, catalogItemName);
          const visibleCredentialsAfterRevoke =
            await getVisibleCredentials(page);
          expect(visibleCredentialsAfterRevoke).not.toContain(
            revokedCredential,
          );
          if (remainingCredential) {
            expect(visibleCredentialsAfterRevoke).toContain(
              remainingCredential,
            );
          }
        }).toPass({ timeout: 15_000, intervals: [1000, 2000, 3000] });

        // Cleanup team gateway
        if (teamGateway) {
          await archestraApiSdk.deleteAgent({
            path: { id: teamGateway.id },
            headers: { Cookie: cookieHeaders },
          });
        }
      }
      // Cleanup admin shared gateway
      if (adminSharedGateway) {
        await archestraApiSdk.deleteAgent({
          path: { id: adminSharedGateway.id },
          headers: { Cookie: cookieHeaders },
        });
      }

      // CLEANUP: Delete created catalog items and mcp servers
      if (newCatalogItem) {
        await archestraApiSdk.deleteInternalMcpCatalogItem({
          path: { id: newCatalogItem.id },
          headers: { Cookie: cookieHeaders },
        });
      }
    });
  });
});

test("Verify Manage Credentials dialog shows correct other users credentials", async ({
  adminPage,
  editorPage,
  memberPage,
  extractCookieHeaders,
  makeRandomString,
}) => {
  test.setTimeout(90_000); // 90 seconds - multiple users installing concurrently
  // Create catalog item as Admin
  // Editor and Member cannot add items to MCP Registry
  const catalogItemName = makeRandomString(10, "mcp");
  const cookieHeaders = await extractCookieHeaders(adminPage);
  const newCatalogItem = await addCustomSelfHostedCatalogItem({
    page: adminPage,
    cookieHeaders,
    catalogItemName,
    scope: "org",
  });
  const MATRIX = [
    { user: "Admin", page: adminPage, canCreateTeamCredential: true },
    { user: "Editor", page: editorPage, canCreateTeamCredential: true },
    // Members lack mcpServer:update permission, so they can only create personal credentials
    { user: "Member", page: memberPage, canCreateTeamCredential: false },
  ] as const;
  let hasCreatedDefaultTeamCredential = false;

  const install = async (page: Page, canCreateTeamCredential: boolean) => {
    await goToMcpRegistry(page);
    await installLocalCatalogItem({ page, catalogItemName });
    await settleRegistryAfterInstall(page);

    if (!canCreateTeamCredential || hasCreatedDefaultTeamCredential) {
      return;
    }

    await addSharedLocalConnection({
      page,
      catalogItemName,
      teamName: DEFAULT_TEAM_NAME,
    });
    await settleRegistryAfterInstall(page);
    hasCreatedDefaultTeamCredential = true;
  };

  // Each user adds a personal credential; the default-team credential is created once.
  for (const { page, canCreateTeamCredential } of MATRIX) {
    await install(page, canCreateTeamCredential);
  }

  // Check Credentials counter
  const checkCredentialsCount = async (page: Page) => {
    await goToPage(page, "/mcp/registry");
    await openManageCredentialsDialog(page, catalogItemName);
    const connectionsButton = page
      .getByRole("dialog")
      .filter({ visible: true })
      .last()
      .getByRole("button", { name: /^Connections\b/ });
    await expect(connectionsButton).toBeVisible();
    await closeOpenDialogs(page);
  };
  for (const { page } of MATRIX) {
    await checkCredentialsCount(page);
  }

  // CLEANUP: Delete created catalog items and mcp servers, non-blocking on purpose
  await archestraApiSdk.deleteInternalMcpCatalogItem({
    path: { id: newCatalogItem.id },
    headers: { Cookie: cookieHeaders },
  });
});

test("Verify tool calling using different static credentials", async ({
  request,
  adminPage,
  editorPage,
  makeRandomString,
  extractCookieHeaders,
}) => {
  test.setTimeout(120_000); // 120 seconds - MCP server startup + tool discovery + tool calls
  const CATALOG_ITEM_NAME = makeRandomString(10, "mcp");
  const cookieHeaders = await extractCookieHeaders(adminPage);
  // Create a shared org-scope test gateway (default + engineering teams)
  const sharedGateway = await createSharedTestGatewayViaApi({
    cookieHeaders,
    gatewayName: makeRandomString(10, "shared-gw"),
  });
  // Create a team-scoped MCP gateway for editor (editor can't see org-scoped gateways)
  const teamGateway = await createTeamMcpGatewayViaApi({
    cookieHeaders,
    teamName: ENGINEERING_TEAM_NAME,
    gatewayName: makeRandomString(10, "gw"),
  });
  // Create catalog item as Admin
  // Editor and Member cannot add items to MCP Registry
  const newCatalogItem = await addCustomSelfHostedCatalogItem({
    page: adminPage,
    cookieHeaders,
    catalogItemName: CATALOG_ITEM_NAME,
    scope: "org",
    envVars: {
      key: "ARCHESTRA_TEST",
      promptOnInstallation: true,
    },
  });
  if (!newCatalogItem) {
    throw new Error("Failed to create catalog item");
  }

  await goToMcpRegistry(adminPage);
  await installLocalCatalogItem({
    page: adminPage,
    catalogItemName: CATALOG_ITEM_NAME,
    envValues: { ARCHESTRA_TEST: "Admin-personal-credential" },
  });
  await settleRegistryAfterInstall(adminPage);

  await goToMcpRegistry(editorPage);
  await installLocalCatalogItem({
    page: editorPage,
    catalogItemName: CATALOG_ITEM_NAME,
    envValues: { ARCHESTRA_TEST: "Editor-personal-credential" },
  });
  await settleRegistryAfterInstall(editorPage);

  // Assign tool to profiles using admin static credential
  await assignCatalogCredentialToGateway({
    page: adminPage,
    catalogItemName: CATALOG_ITEM_NAME,
    credentialName: "admin@example.com",
    gatewayName: sharedGateway.name,
  });
  // Verify tool call result using admin static credential
  await verifyToolCallResultViaApi({
    request,
    expectedResult: "Admin-personal-credential",
    tokenToUse: "org-token",
    toolName: `${CATALOG_ITEM_NAME}__print_archestra_test`,
    profileId: sharedGateway.id,
  });

  // Assign tool to profiles using editor static credential
  await assignCatalogCredentialToGateway({
    page: editorPage,
    catalogItemName: CATALOG_ITEM_NAME,
    credentialName: "editor@example.com",
    gatewayName: teamGateway.name,
  });
  // Verify tool call result using editor static credential
  await verifyToolCallResultViaApi({
    request,
    expectedResult: "Editor-personal-credential",
    tokenToUse: "org-token",
    toolName: `${CATALOG_ITEM_NAME}__print_archestra_test`,
    profileId: teamGateway.id,
  });

  // CLEANUP: Delete existing created MCP servers / installations
  await archestraApiSdk.deleteInternalMcpCatalogItem({
    path: { id: newCatalogItem.id },
    headers: { Cookie: cookieHeaders },
  });
  await archestraApiSdk.deleteAgent({
    path: { id: teamGateway.id },
    headers: { Cookie: cookieHeaders },
  });
  await archestraApiSdk.deleteAgent({
    path: { id: sharedGateway.id },
    headers: { Cookie: cookieHeaders },
  });
});

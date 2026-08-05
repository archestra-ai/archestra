import { archestraApiSdk } from "@archestra/shared";
import type { Page } from "@playwright/test";
import {
  ADMIN_EMAIL,
  DEFAULT_TEAM_NAME,
  E2eTestId,
  EDITOR_EMAIL,
  ENGINEERING_TEAM_NAME,
  MARKETING_TEAM_NAME,
  MEMBER_EMAIL,
} from "../consts";
import { expect, goToPage, test } from "../fixtures";
import {
  addCustomSelfHostedCatalogItem,
  addSharedLocalConnection,
  assignCatalogCredentialToGateway,
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
  selectCredentialOption,
  settleRegistryAfterInstall,
  verifyToolCallResultViaApi,
  waitForMcpServerAbsent,
  waitForMcpServerReadyById,
  waitForMcpServerToolsDiscovered,
} from "../utils";

test.describe.configure({ mode: "serial" });

test.describe("Custom Self-hosted MCP Server - installation and static credentials management (vault disabled, prompt-on-installation disabled)", () => {
  // Matrix tests
  const MATRIX: { user: "Admin" | "Member" }[] = [
    {
      user: "Admin",
    },
    {
      user: "Member",
    },
  ];
  MATRIX.forEach(({ user }) => {
    test(`${user}`, async ({
      adminPage,
      memberPage,
      extractCookieHeaders,
      makeRandomString,
    }) => {
      test.setTimeout(180_000);
      const page = (() => {
        switch (user) {
          case "Admin":
            return adminPage;
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
        await expect(await getVisibleCredentials(page)).toEqual([MEMBER_EMAIL]);
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
        const installedServerId = installResponse.data?.id;
        if (!installedServerId) {
          throw new Error(
            `Install response for ${user} missing server id: ${JSON.stringify(installResponse.data)}`,
          );
        }
        await settleRegistryAfterInstall(page);
        // The API install path doesn't refresh the registry DOM, so probe
        // the backend installation status by ID first — surfaces a backend
        // install error as a real error instead of a 120s DOM-poll timeout,
        // and disambiguates from the same-named personal install above.
        await waitForMcpServerReadyById(page, installedServerId);
        // Follow with the existing DOM wait. This is the implicit "everything
        // settled" signal the rest of the test relies on (TanStack Query
        // refetch cycle has propagated to the registry view, so the gateway-
        // edit dialog below sees the new tools in its catalog).
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
      await openManageCredentialsDialog(page, catalogItemName);
      const connectionsButton = page.getByTestId(
        E2eTestId.McpServerSettingsConnectionsNavButton,
      );
      await expect(connectionsButton).toBeVisible();
      await closeOpenDialogs(page);

      if (user !== "Member") {
        const gatewayNameForAssignment = adminSharedGateway?.name;
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
        // Personal connections are caller-bound: they resolve only at call
        // time for their owner and never appear as static pin options — the
        // dropdown offers team/org service accounts exclusively.
        const expectedAssignableCredentials =
          visibleServersResponse.data
            ?.filter(
              (server) =>
                server.catalogId === newCatalogItem.id &&
                server.scope !== "personal",
            )
            .map(
              (server) =>
                server.teamDetails?.name ?? server.ownerEmail ?? "Deleted user",
            ) ?? [];
        expect(expectedAssignableCredentials.length).toBeGreaterThan(0);
        // Poll instead of a one-shot read: the dropdown renders from a
        // TanStack Query result that can transiently miss a just-created
        // credential until the mount-time refetch lands. The options
        // re-render in place once fresh data arrives, so re-reading
        // converges; a thrown read (options briefly unmounted mid-re-render)
        // counts as "not yet" rather than aborting the poll.
        await expect
          .poll(
            async () =>
              (await getVisibleStaticCredentials(page).catch(() => [])).sort(),
            { timeout: 30_000, intervals: [500, 1000, 2000, 4000] },
          )
          .toEqual([...expectedAssignableCredentials].sort());
        await selectCredentialOption(
          page,
          page.getByRole("option", {
            name: expectedAssignableCredentials[0] ?? "",
          }),
        );
        await saveOpenProfileDialog(page);

        // Revoke the admin's own (personal) credential, then close dialog.
        // Target it by its deterministic test-id rather than the first Revoke
        // button: the row order isn't guaranteed, so a position-based click
        // can revoke the team credential instead, leaving ADMIN_EMAIL present
        // and failing the assertion below.
        const personalServerId = visibleServersResponse.data?.find(
          (server) =>
            server.catalogId === newCatalogItem.id &&
            !server.teamDetails &&
            server.ownerEmail === ADMIN_EMAIL,
        )?.id;
        expect(
          personalServerId,
          "Could not resolve the admin's personal MCP server id to revoke",
        ).toBeTruthy();
        await goToPage(page, "/mcp/registry");
        await openManageCredentialsDialog(page, catalogItemName);
        await page
          .getByTestId(`${E2eTestId.RevokeCredentialButton}-personal`)
          .click();
        await page.waitForLoadState("domcontentloaded");
        await closeOpenDialogs(page);

        // Revoking deletes the backing MCP server via async K8s pod teardown,
        // which keeps the server in getMcpServers (and the dialog) until
        // teardown completes. Wait for the backend to actually drop it (404)
        // before asserting the UI, so the assertion isn't racing teardown
        // latency under CI load — the cause of the prior flake.
        if (personalServerId) {
          await waitForMcpServerAbsent(page, personalServerId);
        }

        // And we check the dialog reflects the revoke. The backend already
        // confirmed deletion above, so this only waits on the UI refetch —
        // not on K8s teardown.
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
        }).toPass({ timeout: 15_000, intervals: [1000, 2000, 3000, 5000] });
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

  // Check Connections counter
  const checkCredentialsCount = async (page: Page) => {
    await goToPage(page, "/mcp/registry");
    await openManageCredentialsDialog(page, catalogItemName);
    const connectionsButton = page.getByTestId(
      E2eTestId.McpServerSettingsConnectionsNavButton,
    );
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

  // Personal connections are caller-bound and can no longer be pinned as
  // static credentials (the installs above stay usable only via
  // resolve-at-call-time for their owners). Static pinning is exercised with
  // team service accounts instead: one per gateway, with distinct env values
  // so the tool result proves which credential served the call.
  await addSharedLocalConnection({
    page: adminPage,
    catalogItemName: CATALOG_ITEM_NAME,
    teamName: DEFAULT_TEAM_NAME,
    envValues: { ARCHESTRA_TEST: "Default-team-credential" },
  });
  await settleRegistryAfterInstall(adminPage);
  await addSharedLocalConnection({
    page: editorPage,
    catalogItemName: CATALOG_ITEM_NAME,
    teamName: ENGINEERING_TEAM_NAME,
    envValues: { ARCHESTRA_TEST: "Engineering-team-credential" },
  });
  await settleRegistryAfterInstall(editorPage);

  // Assign tool to profiles pinning the default-team service account
  await assignCatalogCredentialToGateway({
    page: adminPage,
    catalogItemName: CATALOG_ITEM_NAME,
    credentialName: DEFAULT_TEAM_NAME,
    gatewayName: sharedGateway.name,
  });
  // Verify tool call result using the default-team service account
  await verifyToolCallResultViaApi({
    request,
    expectedResult: "Default-team-credential",
    tokenToUse: "org-token",
    toolName: `${CATALOG_ITEM_NAME}__print_archestra_test`,
    profileId: sharedGateway.id,
  });

  // Assign tool to profiles pinning the engineering-team service account
  await assignCatalogCredentialToGateway({
    page: editorPage,
    catalogItemName: CATALOG_ITEM_NAME,
    credentialName: ENGINEERING_TEAM_NAME,
    gatewayName: teamGateway.name,
  });
  // Verify tool call result using the engineering-team service account
  await verifyToolCallResultViaApi({
    request,
    expectedResult: "Engineering-team-credential",
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

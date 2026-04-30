import { archestraApiSdk } from "@shared";
import {
  DEFAULT_TEAM_NAME,
  ENGINEERING_TEAM_NAME,
  MARKETING_TEAM_NAME,
} from "../consts";
import { test } from "../fixtures";
import {
  addCustomSelfHostedCatalogItem,
  createSharedTestGatewayViaApi,
  goToMcpRegistry,
  installLocalCatalogItem,
  settleRegistryAfterInstall,
  verifyToolCallResultViaApi,
  waitForMcpServerToolsDiscovered,
} from "../utils";

test("Verify tool calling using dynamic credentials", async ({
  request,
  adminPage,
  editorPage,
  memberPage,
  makeRandomString,
  extractCookieHeaders,
}) => {
  test.setTimeout(90_000); // 90 seconds
  const CATALOG_ITEM_NAME = makeRandomString(10, "mcp");
  const cookieHeaders = await extractCookieHeaders(adminPage);
  const sharedGateway = await createSharedTestGatewayViaApi({
    cookieHeaders,
    gatewayName: makeRandomString(10, "shared-gw"),
  });

  // Create catalog item as Admin
  // Editor and Member cannot add items to MCP Registry
  const { name: catalogItemName, id: catalogItemId } =
    await addCustomSelfHostedCatalogItem({
      page: adminPage,
      cookieHeaders,
      catalogItemName: CATALOG_ITEM_NAME,
      scope: "org",
      envVars: {
        key: "ARCHESTRA_TEST",
        promptOnInstallation: true,
      },
    });
  if (!catalogItemName) {
    throw new Error("Failed to create catalog item");
  }

  const MATRIX_A = [
    { user: "Admin", page: adminPage, team: DEFAULT_TEAM_NAME },
    { user: "Editor", page: editorPage, team: ENGINEERING_TEAM_NAME },
    { user: "Member", page: memberPage, team: MARKETING_TEAM_NAME },
  ] as const;

  const install = async ({ page, user, team }: (typeof MATRIX_A)[number]) => {
    const pageCookieHeaders = await extractCookieHeaders(page);

    await goToMcpRegistry(page);
    await installLocalCatalogItem({
      page,
      catalogItemName,
      envValues: { ARCHESTRA_TEST: `${user}-personal-credential` },
    });
    await settleRegistryAfterInstall(page);

    // Members lack mcpServer:update permission and cannot create team installations.
    // After personal install, they see an "Already installed" banner.
    if (user === "Member") {
      return;
    }

    const teamsResponse = await archestraApiSdk.getTeams({
      headers: { Cookie: pageCookieHeaders },
    });
    if (teamsResponse.error) {
      throw new Error(
        `Failed to get teams for ${user}: ${JSON.stringify(teamsResponse.error)}`,
      );
    }

    const teamId = teamsResponse.data?.data.find(
      (currentTeam) => currentTeam.name === team,
    )?.id;
    if (!teamId) {
      throw new Error(`Team "${team}" not found for ${user}`);
    }

    const installResponse = await archestraApiSdk.installMcpServer({
      headers: { Cookie: pageCookieHeaders },
      body: {
        name: catalogItemName,
        catalogId: catalogItemId,
        scope: "team",
        teamId,
        environmentValues: {
          ARCHESTRA_TEST: `${team}-team-credential`,
        },
      },
    });
    if (installResponse.error) {
      throw new Error(
        `Failed to install shared connection for ${user}: ${JSON.stringify(installResponse.error)}`,
      );
    }
    await settleRegistryAfterInstall(page);
    await waitForMcpServerToolsDiscovered(page, catalogItemName);
  };

  // Each user adds personal and 1 team credential
  for (const config of MATRIX_A) {
    await install(config);
  }

  const toolsResponse = await archestraApiSdk.getTools({
    headers: { Cookie: cookieHeaders },
  });
  const toolIds =
    toolsResponse.data
      ?.filter((tool) => tool.name.startsWith(`${CATALOG_ITEM_NAME}__`))
      .map((tool) => tool.id) ?? [];
  if (toolIds.length === 0) {
    throw new Error(
      `No discovered tools found for dynamic-credentials catalog ${CATALOG_ITEM_NAME}`,
    );
  }

  for (const toolId of toolIds) {
    const assignResponse = await archestraApiSdk.assignToolToAgent({
      headers: { Cookie: cookieHeaders },
      path: {
        agentId: sharedGateway.id,
        toolId,
      },
      body: {
        resolveAtCallTime: true,
        credentialResolutionMode: "dynamic",
      },
    });
    if (assignResponse.error) {
      throw new Error(
        `Failed to assign dynamic credential tool ${toolId}: ${JSON.stringify(assignResponse.error)}`,
      );
    }
  }

  /**
   * Credentials we have:
   * Admin personal credential, Default team credential
   * Editor personal credential, Engineering team credential
   * Member personal credential only (Members lack mcpServer:update, cannot create team installations)
   *
   * Team membership:
   * Admin: Default team
   * Editor: Engineering team, Marketing team, Default team
   * Member: Marketing team, Default team
   *
   * Default Team and Engineering Team are assigned to default profile
   */

  // Verify tool call results using dynamic credential
  // Team tokens resolve to team-owned servers only (not personal credentials of team members)
  const MATRIX_B = [
    {
      // All three users are in Default team with personal credentials;
      // resolution order is non-deterministic (no ORDER BY in findByCatalogId),
      // so we just verify a credential resolves successfully
      tokenToUse: "default-team",
      expectedResult: "AnySuccessText",
    },
    {
      // Engineering team token resolves to the Engineering team-owned server
      tokenToUse: "engineering-team",
      expectedResult: `${ENGINEERING_TEAM_NAME}-team-credential`,
    },
    {
      tokenToUse: "marketing-team",
      expectedResult: "Error", // Marketing team is not assigned to default profile so it should throw an error
    },
  ] as const;
  for (const { expectedResult, tokenToUse } of MATRIX_B) {
    await verifyToolCallResultViaApi({
      request,
      expectedResult,
      tokenToUse,
      toolName: `${CATALOG_ITEM_NAME}__print_archestra_test`,
      profileId: sharedGateway.id,
    });
  }

  // CLEANUP: Delete existing created MCP servers / installations
  await archestraApiSdk.deleteInternalMcpCatalogItem({
    path: { id: catalogItemId },
    headers: { Cookie: cookieHeaders },
  });
  await archestraApiSdk.deleteAgent({
    path: { id: sharedGateway.id },
    headers: { Cookie: cookieHeaders },
  });
});

import { archestraApiSdk } from "@shared";
import {
  ADMIN_EMAIL,
  E2eTestId,
  EDITOR_EMAIL,
  MEMBER_EMAIL,
} from "../../consts";
import { expect, goToPage, test } from "../../fixtures";
import {
  addCustomSelfHostedCatalogItem,
  assignCatalogCredentialToGateway,
  assignEngineeringTeamToDefaultProfileViaApi,
  openManageCredentialsDialog,
  verifyToolCallResultViaApi,
} from "../../utils";
import {
  addSharedLocalConnection,
  goToMcpRegistry,
  installLocalCatalogItem,
  settleRegistryAfterInstall,
} from "../../utils/mcp-registry";

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
  await assignEngineeringTeamToDefaultProfileViaApi({ cookieHeaders });

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
    { user: "Admin", page: adminPage, team: "Default" },
    { user: "Editor", page: editorPage, team: "Engineering" },
    { user: "Member", page: memberPage, team: "Marketing" },
  ] as const;

  const install = async ({ page, user, team }: (typeof MATRIX_A)[number]) => {
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

    await addSharedLocalConnection({
      page,
      catalogItemName,
      teamName: team,
      envValues: { ARCHESTRA_TEST: `${team}-team-credential` },
    });
    await settleRegistryAfterInstall(page);
  };

  // Each user adds personal and 1 team credential
  for (const config of MATRIX_A) {
    await install(config);
  }

  // Assign tool to profiles using dynamic credential
  await assignCatalogCredentialToGateway({
    page: adminPage,
    catalogItemName: CATALOG_ITEM_NAME,
    credentialName: "Resolve at call time",
  });

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
  // Personal credential takes priority over team credential
  const MATRIX_B = [
    {
      // All three users are in Default team with personal credentials;
      // resolution order is non-deterministic (no ORDER BY in findByCatalogId),
      // so we just verify a credential resolves successfully
      tokenToUse: "default-team",
      expectedResult: "AnySuccessText",
    },
    {
      tokenToUse: "engineering-team",
      expectedResult: "Editor-personal-credential",
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
      cookieHeaders,
    });
  }

  // Then we remove ALL personal credentials and verify it uses team credentials as second priority
  await goToPage(adminPage, "/mcp/registry");
  await openManageCredentialsDialog(adminPage, CATALOG_ITEM_NAME);
  await adminPage
    .getByTestId(`${E2eTestId.RevokeCredentialButton}-${ADMIN_EMAIL}`)
    .click();
  await adminPage
    .getByTestId(`${E2eTestId.RevokeCredentialButton}-${EDITOR_EMAIL}`)
    .click();
  await adminPage
    .getByTestId(`${E2eTestId.RevokeCredentialButton}-${MEMBER_EMAIL}`)
    .click();
  await adminPage.waitForLoadState("domcontentloaded");
  const MATRIX_C = [
    {
      // All three users are in Default team; after revoking personal credentials,
      // the resolution picks any team credential owned by a Default team member (non-deterministic)
      tokenToUse: "default-team",
      expectedResult: "AnySuccessText",
    },
    {
      // Only Editor is in Engineering team, so this deterministically uses the Engineering team credential
      tokenToUse: "engineering-team",
      expectedResult: "Engineering-team-credential",
    },
  ] as const;
  for (const { expectedResult, tokenToUse } of MATRIX_C) {
    await verifyToolCallResultViaApi({
      request,
      expectedResult,
      tokenToUse,
      toolName: `${CATALOG_ITEM_NAME}__print_archestra_test`,
      cookieHeaders,
    });
  }

  // CLEANUP: Delete existing created MCP servers / installations
  await archestraApiSdk.deleteInternalMcpCatalogItem({
    path: { id: catalogItemId },
    headers: { Cookie: cookieHeaders },
  });
});

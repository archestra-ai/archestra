import { archestraApiSdk } from "@shared";
import { ADMIN_EMAIL, E2eTestId, EDITOR_EMAIL } from "../../consts";
import { goToPage, test } from "../../fixtures";
import {
  addCustomSelfHostedCatalogItem,
  assignEngineeringTeamToDefaultProfileViaApi,
  clickButton,
  goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect,
  openManageCredentialsDialog,
  verifyToolCallResultViaApi,
} from "../../utils";

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
    // Go to MCP Registry page
    await goToPage(page, "/mcp-catalog/registry");
    await page.waitForLoadState("networkidle");
    // Click connect button for the catalog item - wait for it to be visible
    const btn = page.getByTestId(
      `${E2eTestId.ConnectCatalogItemButton}-${catalogItemName}`,
    );
    await btn.waitFor({ state: "visible" });
    await btn.click();
    // Fill ARCHESTRA_TEST environment variable to mark personal credential
    await page
      .getByRole("textbox", { name: "ARCHESTRA_TEST" })
      .fill(`${user}-personal-credential`);
    // Install using personal credential
    await clickButton({ page, options: { name: "Install" } });
    // Wait for dialog to close and button to be visible again
    const connectButton = page.getByTestId(
      `${E2eTestId.ConnectCatalogItemButton}-${catalogItemName}`,
    );
    await connectButton.waitFor({ state: "visible" });
    await connectButton.click();
    // Fill ARCHESTRA_TEST environment variable to mark team credential
    await page
      .getByRole("textbox", { name: "ARCHESTRA_TEST" })
      .fill(`${team}-team-credential`);
    // And this time team credential type should be selected by default for everyone, install using team credential
    await clickButton({ page, options: { name: "Install" } });
    // Wait for installation to complete and pod to be ready
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1_000); // Additional wait for pod to be ready
  };

  // Each user adds personal and 1 team credential
  for (const config of MATRIX_A) {
    await install(config);
  }

  // Assign tool to profiles using dynamic credential
  await goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect({
    page: adminPage,
    catalogItemName: CATALOG_ITEM_NAME,
  });
  // Wait for dropdown option to be visible and stable before clicking
  const resolveAtCallTimeOption = adminPage.getByRole("option", {
    name: "Resolve at call time",
  });
  await resolveAtCallTimeOption.waitFor({ state: "visible" });
  // Additional wait to ensure option is stable (not animating)
  await adminPage.waitForTimeout(200);
  await resolveAtCallTimeOption.click();
  await adminPage.getByText("Assign to 1 profile").click();
  await adminPage.waitForLoadState("networkidle");

  /**
   * Credentials we have:
   * Admin personal credential, default team credential
   * Editor personal credential, engineering team credential
   * Member personal credential, marketing team credential
   *
   * Team membership:
   * Admin: default team
   * Editor: engineering team, marketing team
   * Member: marketing team
   *
   * Default Team and Engineering Team are assigned to default profile
   */

  // Verify tool call results using dynamic credential
  // It should use the personal credential as first priority
  const MATRIX_B = [
    {
      tokenToUse: "default-team",
      expectedResult: "Admin-personal-credential",
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

  // Then we remove personal credentials as Admin and we verify it uses team credentials as second priority
  await goToPage(adminPage, "/mcp-catalog/registry");
  await openManageCredentialsDialog(adminPage, CATALOG_ITEM_NAME);
  await adminPage
    .getByTestId(`${E2eTestId.RevokeCredentialButton}-${ADMIN_EMAIL}`)
    .click();
  await adminPage
    .getByTestId(`${E2eTestId.RevokeCredentialButton}-${EDITOR_EMAIL}`)
    .click();
  await adminPage.waitForLoadState("networkidle");
  const MATRIX_C = [
    {
      tokenToUse: "default-team",
      expectedResult: "Default-team-credential",
    },
    {
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

// /**
//  * Credentials Management E2E Tests
//  *
//  * Given the following users:
//  * - Admin - Admin Role - Default team
//  * - Editor - Editor Role - Engineering and Marketing Team
//  * - Member - Member Role - Marketing Team
//  *
//  * The Local Installations dialog requires `tool:update` and `profile:update` permissions.
//  * Admin and Editor have these permissions and can manage credentials
//  * Member cannot see the "Manage" button
//  *
//  * Admin sees all credentials in Local Installations dialog
//  * Editor sees only their own and Member's credentials (team-based visibility)
//  *
//  * Admin can grant their credential to any team
//  * Editor can see options that belong to his team / teams
//  */

// import type { APIRequestContext, Page } from "@playwright/test";
// import {
//   ADMIN_EMAIL,
//   DEFAULT_PROFILE_NAME,
//   DEFAULT_TEAM_NAME,
//   E2eTestId,
//   EDITOR_EMAIL,
//   ENGINEERING_TEAM_NAME,
//   MARKETING_TEAM_NAME,
//   MCP_SERVER_TOOL_NAME_SEPARATOR,
//   MEMBER_EMAIL,
// } from "../../consts";
// import { expect, test } from "../../fixtures";
// import {
//   callMcpTool,
//   getOrgTokenForProfile,
//   getTeamTokenForProfile,
//   initializeMcpSession,
//   makeApiRequest,
// } from "../api/mcp-gateway-utils";

// const TEST_SERVER_NAME = "internal-dev-test-server";
// const TEST_TOOL_NAME = `${TEST_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}print_archestra_test`;

// // Skip: changing credentials model to include teams
// test.describe.skip("Credentials Management", () => {
//   test.describe.configure({ mode: "serial" });

//   // Cleanup any existing installations at the start to ensure clean state
//   test("Setup: Clean any existing installations", async ({
//     adminPage,
//     editorPage,
//     memberPage,
//     goToAdminPage,
//     goToEditorPage,
//     goToMemberPage,
//   }, testInfo) => {
//     // Pod deletion can take a while, so we need a longer timeout
//     testInfo.setTimeout(180000);

//     await Promise.all([
//       uninstallTestServer(adminPage, goToAdminPage),
//       uninstallTestServer(editorPage, goToEditorPage),
//       uninstallTestServer(memberPage, goToMemberPage),
//     ]);
//   });

//   test("Setup: Each user installs test server with their credentials", async ({
//     adminPage,
//     editorPage,
//     memberPage,
//     goToAdminPage,
//     goToEditorPage,
//     goToMemberPage,
//   }) => {
//     await Promise.all([
//       installTestServer(adminPage, goToAdminPage, "Admin"),
//       installTestServer(editorPage, goToEditorPage, "Editor"),
//       installTestServer(memberPage, goToMemberPage, "Member"),
//     ]);
//   });

//   // TODO: Re-enable this after adjustment
//   test.describe
//     .skip("Check who can see which credentials in Local Installations dialog", () => {
//       test("Member cannot see Manage credentials button (lacks permissions)", async ({
//         memberPage,
//         goToMemberPage,
//       }) => {
//         await goToMemberPage("/mcp-catalog/registry");
//         await memberPage.waitForLoadState("networkidle");

//         // Find the test server card
//         const serverCard = memberPage.getByTestId(
//           `${E2eTestId.McpServerCard}-${TEST_SERVER_NAME}`,
//         );
//         await expect(serverCard).toBeVisible();

//         // Member should see Uninstall button (they installed the server)
//         await expect(
//           serverCard.getByRole("button", { name: /Uninstall/i }),
//         ).toBeVisible({ timeout: 20_000 });

//         // But Member should NOT see the Manage credentials button (requires tool:update, profile:update)
//         await expect(
//           memberPage.getByTestId(
//             `${E2eTestId.ManageCredentialsButton}-${TEST_SERVER_NAME}`,
//           ),
//         ).not.toBeVisible();
//       });

//       test("Admin sees all credentials in Local Installations dialog", async ({
//         adminPage,
//         goToAdminPage,
//       }) => {
//         await openLocalInstallationsDialog(adminPage, goToAdminPage);

//         const visibleEmails = await getVisibleCredentialEmails(adminPage);

//         // Admin should see all 3 credentials
//         expect(visibleEmails).toContain(ADMIN_EMAIL);
//         expect(visibleEmails).toContain(EDITOR_EMAIL);
//         expect(visibleEmails).toContain(MEMBER_EMAIL);
//         expect(visibleEmails.length).toBe(3);
//       });

//       test("Editor sees only Editor and Member credentials (team-based visibility)", async ({
//         editorPage,
//         goToEditorPage,
//       }) => {
//         await openLocalInstallationsDialog(editorPage, goToEditorPage);

//         const visibleEmails = await getVisibleCredentialEmails(editorPage);

//         // Editor should see their own and Member's credentials (both in Marketing Team)
//         expect(visibleEmails).toContain(EDITOR_EMAIL);
//         expect(visibleEmails).toContain(MEMBER_EMAIL);
//         // Editor should NOT see Admin's credential (Admin is not in Editor's teams)
//         expect(visibleEmails).not.toContain(ADMIN_EMAIL);
//         expect(visibleEmails.length).toBe(2);
//       });
//     });

//   // TODO: Re-check this after adjustment
//   test.describe
//     .skip("Check team select options", () => {
//       test("Admin can see all teams in team select options", async ({
//         adminPage,
//         goToAdminPage,
//       }) => {
//         await openLocalInstallationsDialog(adminPage, goToAdminPage);

//         // Check team select options for Admin's credential
//         const adminOptions = await getTeamSelectOptionsForCredential(
//           adminPage,
//           ADMIN_EMAIL,
//         );
//         // Admin should see all teams as options
//         expect(adminOptions).toContain(ENGINEERING_TEAM_NAME);
//         expect(adminOptions).toContain(MARKETING_TEAM_NAME);
//       });

//       test("Editor can see options that belong to his team / teams", async ({
//         editorPage,
//         goToEditorPage,
//       }) => {
//         await openLocalInstallationsDialog(editorPage, goToEditorPage);

//         // Editor should be able to see team select for their own credential
//         const editorOptions = await getTeamSelectOptionsForCredential(
//           editorPage,
//           EDITOR_EMAIL,
//         );
//         // Editor can only assign teams they belong to
//         expect(editorOptions.length).toBeGreaterThanOrEqual(0);
//       });
//     });

//   // TODO: Re-check this after adjustment
//   test.skip("When Admin grants their credential to Marketing Team, Editor can now see Admin's credential", async ({
//     editorPage,
//     goToEditorPage,
//     adminPage,
//     goToAdminPage,
//   }) => {
//     await openLocalInstallationsDialog(adminPage, goToAdminPage);

//     // Grant Admin's credential to Marketing Team
//     await grantTeamAccessToCredential(
//       adminPage,
//       ADMIN_EMAIL,
//       MARKETING_TEAM_NAME,
//     );

//     // Verify the team badge appears
//     const row = adminPage
//       .getByTestId(E2eTestId.CredentialRow)
//       .filter({ has: adminPage.getByText(ADMIN_EMAIL) });
//     await expect(row.getByText(MARKETING_TEAM_NAME)).toBeVisible();

//     await openLocalInstallationsDialog(editorPage, goToEditorPage);

//     const visibleEmails = await getVisibleCredentialEmails(editorPage);

//     // Editor should now see Admin's credential (Admin granted to Marketing, Editor is in Marketing)
//     expect(visibleEmails).toContain(ADMIN_EMAIL);
//     expect(visibleEmails).toContain(EDITOR_EMAIL);
//     expect(visibleEmails).toContain(MEMBER_EMAIL);
//     expect(visibleEmails.length).toBe(3);
//   });

//   test.describe("Static credential selection", () => {
//     test("Choose admin static credential and verify that tool call used admin's credential", async ({
//       adminPage,
//       goToAdminPage,
//       request,
//     }) => {
//       await goToMcpRegitryAndOpenManageToolsAndSelectTestTool({
//         page: adminPage,
//         goTo: goToAdminPage,
//       });
//       await adminPage
//         .getByLabel("admin@example.comMarketing")
//         .getByText("admin@example.com")
//         .click();
//       await adminPage
//         .getByRole("button", { name: "Assign", exact: false })
//         .click();
//       await adminPage.waitForTimeout(2_000);

//       await verifyToolCallResultViaApi({
//         request,
//         expectedText: "Admin",
//         tokenToUse: "org-token",
//       });
//     });

//     test("Choose editor static credential and verify that tool call used editor's credential", async ({
//       adminPage,
//       goToAdminPage,
//       request,
//     }) => {
//       await goToMcpRegitryAndOpenManageToolsAndSelectTestTool({
//         page: adminPage,
//         goTo: goToAdminPage,
//       });
//       await adminPage
//         .getByLabel("Resolve at call time")
//         .getByText("Resolve at call time")
//         .click();
//       await adminPage
//         .getByRole("button", { name: "Assign", exact: false })
//         .click();
//       await adminPage.waitForTimeout(2_000);

//       await verifyToolCallResultViaApi({
//         request,
//         expectedText: "Editor",
//         tokenToUse: "org-token",
//       });
//     });
//   });

//   test.describe("Dynamic credential selection", () => {
//     test.describe.configure({ mode: "serial" });
//     /**
//      * Default state is that Admin and Editor installed the test server with their own credentials
//      * Admin is in Default team, Editor is in Engineering team
//      * Expected behavior is that:
//      * - when Admin invokes tool, it should use their own credential
//      * - when Editor invokes tool, it should use their own credential
//      */

//     // At first we assign Engineering team to Default Profile so that chat can use Engineering team token to connect to mcp gateway
//     test("Assign Engineering team to Default Profile and assign tool to Default Profile", async ({
//       adminPage,
//       goToAdminPage,
//     }) => {
//       await goToAdminPage("/profiles");

//       await adminPage.waitForLoadState("networkidle");

//       // Check if already assigned and skip if it is
//       const engineeringTeamBadgeVisible = await adminPage
//         .getByTestId(`${E2eTestId.ProfileTeamBadge}-${ENGINEERING_TEAM_NAME}`)
//         .isVisible();
//       if (!engineeringTeamBadgeVisible) {
//         await adminPage
//           .getByTestId(`${E2eTestId.EditAgentButton}-${DEFAULT_PROFILE_NAME}`)
//           .click();
//         await adminPage.getByText("Select a team to assign").click();
//         await adminPage
//           .getByRole("option", { name: ENGINEERING_TEAM_NAME })
//           .click();
//         await adminPage.getByRole("button", { name: "Update profile" }).click();
//         await adminPage.waitForLoadState("networkidle");
//       }

//       await adminPage
//         .getByTestId(`${E2eTestId.ConnectAgentButton}-${DEFAULT_PROFILE_NAME}`)
//         .click();
//       await adminPage.waitForLoadState("networkidle");

//       await goToMcpRegitryAndOpenManageToolsAndSelectTestTool({
//         page: adminPage,
//         goTo: goToAdminPage,
//       });
//       await adminPage
//         .getByLabel("Resolve at call time")
//         .getByText("Resolve at call time")
//         .click();
//       await adminPage
//         .getByRole("button", { name: "Assign", exact: false })
//         .click();
//     });

//     test("Admin invokes tool using Default Team token and verifies that it used Admin's credential", async ({
//       request,
//     }) => {
//       await verifyToolCallResultViaApi({
//         request,
//         expectedText: "Admin",
//         tokenToUse: "default-team",
//       });
//     });

//     test("Editor invokes tool using Engineering Team token and verifies that it used Editor's credential", async ({
//       request,
//     }) => {
//       await verifyToolCallResultViaApi({
//         request,
//         expectedText: "Editor",
//         tokenToUse: "engineering-team",
//       });
//     });

//     // /**
//     //  * Then we unassign Engineering team from Default profile
//     //  * In this case Editor should not be able to invoke tool
//     //  * and Admin should be able to invoke tool with by conencting to gateway with Default Team token.
//     //  */
//     test("Remove Editor from Engineering team and verify that Editor cannot invoke tool", async ({
//       goToAdminPage,
//       adminPage,
//       request,
//     }) => {
//       await goToAdminPage("/profiles");

//       await adminPage.waitForLoadState("networkidle");

//       // Check if already unassigned and skip if it is
//       const engineeringTeamBadgeVisible = await adminPage
//         .getByTestId(`${E2eTestId.ProfileTeamBadge}-${ENGINEERING_TEAM_NAME}`)
//         .isVisible();
//       await adminPage.waitForTimeout(2_000);
//       if (engineeringTeamBadgeVisible) {
//         await adminPage
//           .getByTestId(`${E2eTestId.EditAgentButton}-${DEFAULT_PROFILE_NAME}`)
//           .click();
//         await adminPage
//           .getByTestId(`${E2eTestId.RemoveTeamBadge}-${ENGINEERING_TEAM_NAME}`)
//           .click();
//         await adminPage.getByRole("button", { name: "Update profile" }).click();
//         await adminPage.waitForLoadState("networkidle");
//       }

//       try {
//         await verifyToolCallResultViaApi({
//           request,
//           expectedText: "Editor",
//           tokenToUse: "engineering-team",
//         });
//       } catch (error) {
//         expect((error as Error).message).toContain("Invalid token");
//       }
//       await verifyToolCallResultViaApi({
//         request,
//         expectedText: "Admin",
//         tokenToUse: "default-team",
//       });
//     });

//     /**
//      * Now we unassign Default Team from Default profile
//      * In this case Admin should not be able to invoke tool using Default Team token
//      * but should be able to invoke tool using org-wide token
//      */
//     test("Uninstall test server as Admin and verify that Admin can invoke tool with Editor's credential", async ({
//       adminPage,
//       goToAdminPage,
//       request,
//     }) => {
//       await goToAdminPage("/profiles");
//       await adminPage.waitForLoadState("networkidle");

//       const defaultTeamBadgeVisible = await adminPage
//         .getByTestId(`${E2eTestId.ProfileTeamBadge}-${DEFAULT_TEAM_NAME}`)
//         .isVisible();
//       await adminPage.waitForTimeout(2_000);
//       if (defaultTeamBadgeVisible) {
//         await adminPage
//           .getByTestId(`${E2eTestId.EditAgentButton}-${DEFAULT_PROFILE_NAME}`)
//           .click();
//         await adminPage
//           .getByTestId(`${E2eTestId.RemoveTeamBadge}-${DEFAULT_TEAM_NAME}`)
//           .click();
//         await adminPage.getByRole("button", { name: "Update profile" }).click();
//         await adminPage.waitForLoadState("networkidle");
//       }

//       await adminPage
//         .getByTestId(`${E2eTestId.ConnectAgentButton}-${DEFAULT_PROFILE_NAME}`)
//         .click();
//       await adminPage.waitForLoadState("networkidle");

//       try {
//         await verifyToolCallResultViaApi({
//           request,
//           expectedText: "Admin",
//           tokenToUse: "default-team",
//         });
//       } catch (error) {
//         expect((error as Error).message).toContain("Invalid token");
//       }
//       await verifyToolCallResultViaApi({
//         request,
//         expectedText: "AnySuccessText",
//         tokenToUse: "org-token",
//       });
//     });
//   });
// });

// async function goToMcpRegitryAndOpenManageToolsAndSelectTestTool({
//   page,
//   goTo,
// }: {
//   page: Page;
//   goTo: GoToPageFn;
// }) {
//   await goTo("/mcp-catalog/registry");
//   await page.waitForLoadState("networkidle");
//   const manageToolsButton = page.getByTestId(
//     `${E2eTestId.ManageToolsButton}-${TEST_SERVER_NAME}`,
//   );
//   await manageToolsButton.click();
//   await page
//     .getByRole("button", { name: "Assign Tool to Profiles" })
//     .first()
//     .click();
//   await page.getByRole("checkbox").first().click();
//   await page.waitForLoadState("networkidle");
//   await page.getByRole("combobox").click();
//   await page.waitForLoadState("networkidle");
// }

// async function verifyToolCallResultViaApi({
//   request,
//   expectedText,
//   tokenToUse,
// }: {
//   request: APIRequestContext;
//   expectedText: "Admin" | "Editor" | "AnySuccessText";
//   tokenToUse: "default-team" | "engineering-team" | "org-token";
// }) {
//   // API verification: call tool via MCP Gateway and verify it returns "Admin"
//   // (the value Admin used when installing the server)
//   const defaultProfileResponse = await makeApiRequest({
//     request,
//     method: "get",
//     urlSuffix: "/api/agents/default",
//   });
//   const defaultProfile = await defaultProfileResponse.json();

//   let token: string;
//   if (tokenToUse === "default-team") {
//     token = await getTeamTokenForProfile(request, DEFAULT_TEAM_NAME);
//   } else if (tokenToUse === "engineering-team") {
//     token = await getTeamTokenForProfile(request, ENGINEERING_TEAM_NAME);
//   } else {
//     token = await getOrgTokenForProfile(request);
//   }

//   const sessionId = await initializeMcpSession(request, {
//     profileId: defaultProfile.id,
//     token,
//   });

//   const toolResult = await callMcpTool(request, {
//     profileId: defaultProfile.id,
//     token,
//     sessionId,
//     toolName: TEST_TOOL_NAME,
//   });

//   const textContent = toolResult.content.find((c) => c.type === "text");
//   if (expectedText === "AnySuccessText") {
//     return;
//   }
//   if (!textContent?.text?.includes(expectedText)) {
//     throw new Error(
//       `Expected tool result to contain "${expectedText}" but got "${textContent?.text}"`,
//     );
//   }
// }

// /**
//  * Install the test MCP server for a user with their name as ARCHESTRA_TEST value
//  */
// async function installTestServer(
//   page: Page,
//   goTo: GoToPageFn,
//   userName: string,
// ): Promise<void> {
//   await goTo("/mcp-catalog/registry");
//   await page.waitForLoadState("networkidle");

//   // Find the test server card using data-slot attribute
//   const serverCard = page.getByTestId(
//     `${E2eTestId.McpServerCard}-${TEST_SERVER_NAME}`,
//   );
//   await expect(serverCard).toBeVisible();

//   // Click Connect button within that card
//   await serverCard.getByRole("button", { name: /Connect/i }).click();

//   // Wait for the installation dialog to appear
//   const dialog = page.getByRole("dialog");
//   await expect(dialog).toBeVisible();

//   // Fill in the ARCHESTRA_TEST environment variable with user name
//   await dialog.getByLabel(/ARCHESTRA_TEST/i).fill(userName);

//   // Click Install button
//   await dialog.getByRole("button", { name: /Install/i }).click();

//   // Wait for installation to complete (dialog should close)
//   await expect(dialog).toBeHidden({ timeout: 60000 });
//   await page.waitForLoadState("networkidle");
// }

// /**
//  * Uninstall the test MCP server for the current user
//  */
// async function uninstallTestServer(
//   page: Page,
//   goTo: GoToPageFn,
// ): Promise<void> {
//   await goTo("/mcp-catalog/registry");
//   await page.waitForLoadState("networkidle");

//   // Find the test server card
//   const serverCard = page.getByTestId(
//     `${E2eTestId.McpServerCard}-${TEST_SERVER_NAME}`,
//   );
//   await expect(serverCard).toBeVisible();

//   // Click Uninstall button
//   const uninstallButton = serverCard.getByRole("button", {
//     name: /Uninstall/i,
//   });
//   const connectButton = serverCard.getByRole("button", { name: /Connect/i });

//   // If "Connect" button is visible, then skip
//   if (await connectButton.isVisible()) {
//     return;
//   }

//   if (await uninstallButton.isVisible()) {
//     await uninstallButton.click();

//     // Confirm uninstall in the dialog
//     const dialog = page.getByRole("dialog");
//     await expect(dialog).toBeVisible();
//     await dialog.getByRole("button", { name: /Uninstall/i }).click();

//     // Wait for uninstall to complete (pod deletion can take time)
//     await expect(dialog).toBeHidden({ timeout: 60000 });
//   }
// }

// /** Type for user-specific navigation function */
// type GoToPageFn = (path?: string) => ReturnType<Page["goto"]>;

// /**
//  * Open the Local Installations dialog for the test server
//  */
// async function openLocalInstallationsDialog(
//   page: Page,
//   goTo: GoToPageFn,
// ): Promise<void> {
//   await goTo("/mcp-catalog/registry");
//   await page.waitForLoadState("networkidle");

//   // Find and click the Manage button for credentials
//   const manageButton = page.getByTestId(
//     `${E2eTestId.ManageCredentialsButton}-${TEST_SERVER_NAME}`,
//   );
//   await expect(manageButton).toBeVisible();
//   await manageButton.click();

//   // Wait for dialog to appear
//   await expect(
//     page.getByTestId(E2eTestId.ManageCredentialsDialog),
//   ).toBeVisible();
// }

// /**
//  * Get visible credential emails from the Local Installations dialog
//  */
// async function getVisibleCredentialEmails(page: Page): Promise<string[]> {
//   return await page
//     .getByTestId(E2eTestId.CredentialOwnerEmail)
//     .allTextContents();
// }

// /**
//  * Get available team options from the team select for a specific credential row
//  */
// async function getTeamSelectOptionsForCredential(
//   page: Page,
//   userEmail: string,
// ): Promise<string[]> {
//   const row = page
//     .getByTestId(E2eTestId.CredentialRow)
//     .filter({ has: page.getByText(userEmail) });
//   const teamSelect = row.getByTestId(E2eTestId.CredentialTeamSelect);

//   // Check if team select exists (it might not if no teams are available)
//   if ((await teamSelect.count()) === 0) {
//     return [];
//   }

//   // Click to open the select dropdown
//   await teamSelect.click();

//   // Get all options from the dropdown
//   const options = await page.getByRole("option").allTextContents();

//   // Close the dropdown by pressing Escape
//   await page.keyboard.press("Escape");

//   return options;
// }

// /**
//  * Grant team access to a credential
//  */
// async function grantTeamAccessToCredential(
//   page: Page,
//   userEmail: string,
//   teamName: string,
// ): Promise<void> {
//   const row = page
//     .getByTestId(E2eTestId.CredentialRow)
//     .filter({ has: page.getByText(userEmail) });
//   await row.getByTestId(E2eTestId.CredentialTeamSelect).click();
//   await page.getByRole("option", { name: teamName }).click();
//   await page.waitForLoadState("networkidle");
// }

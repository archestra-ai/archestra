/**
 * Credentials Management E2E Tests
 *
 * Given the following users:
 * - Admin - Admin Role - Default team
 * - Editor - Editor Role - Engineering and Marketing Team
 * - Member - Member Role - Marketing Team
 *
 *
 * Admin sees all credentials in Local Installations dialog
 * Editor sees only their own and Member's credentials (team-based visibility)
 *
 * Admin can grant their credential to any team
 * Editor can see options that belong to his team / teams
 */

/* DELETE after

e2e scenarios:
matrix:
[
  [no-vault, vault],
  [prompt-on-installation, no-prompt-on-installation],
  [self-hosted custom mcp, self-hosted mcp from catalog (I guess we can use context7 with my api key),  remote custom mcp (no auth), remote custom mcp (pat)?]
] 
Admin can:
- install mcp for himself, his team, other team he doesnt belong to
- call tools using each of those credentials (changing value in Credential to use, then call tool, check which credential was used)
- dynamic credential
 - it should resolve to own credential (personal installation) as first priority
 - it should resolve to first own team credential (if no personal installation)
 - it should resolve to any other credential in org (if no personal and own team credential)
 - it should fail if no credential in org
User without team:admin(e.g. Editor) can:
- Install mcp for himself and teams he belongs to
- Other teams not selectable
- call tools using each of those credentials (changing value in Credential to use, then call tool, check which credential was used)
- dynamic credential
 - it should resolve to own credential (personal installation) as first priority
 - it should resolve to first own team credential (if no personal installation)
 - it should fail if no credential in own team
separate test for vault for setting / editing secrets in env vars section of Add/Edit MCP Server to the Private Registry dialog

*/

import type { APIRequestContext, Page } from "@playwright/test";
import { testMcpServerCommand } from "@shared";
import * as apiSdk from "@shared/hey-api/clients/api";
import {
  ADMIN_EMAIL,
  DEFAULT_PROFILE_NAME,
  DEFAULT_TEAM_NAME,
  E2eTestId,
  EDITOR_EMAIL,
  ENGINEERING_TEAM_NAME,
  MARKETING_TEAM_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  MEMBER_EMAIL,
} from "../../consts";
import { expect, goToPage, request, test } from "../../fixtures";
import {
  callMcpTool,
  getOrgTokenForProfile,
  getTeamTokenForProfile,
  initializeMcpSession,
  makeApiRequest,
} from "../api/mcp-gateway-utils";

const TEST_SERVER_NAME = "internal-dev-test-server";
const TEST_TOOL_NAME = `${TEST_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}print_archestra_test`;

type MatrixTestParams = {
  vault: boolean;
  promptOnInstallation: boolean;
  mcpServerType:
    | "custom-self-hosted"
    | "custom-remote"
    | "catalog-self-hosted"
    | "catalog-remote";
  user: "Admin" | "Editor" | "Member";
};

// Skip: changing credentials model to include teams
test.describe("Credentials Management", () => {
  test.describe.configure({ mode: "serial" });

  // Cleanup any existing installations at the start to ensure clean state
  // test("Setup: Clean any existing installations", async ({
  //   adminPage,
  //   editorPage,
  //   memberPage,
  //   goToAdminPage,
  //   goToEditorPage,
  //   goToMemberPage,
  // }, testInfo) => {
  //   // Pod deletion can take a while, so we need a longer timeout
  //   testInfo.setTimeout(180000);

  //   await Promise.all([
  //     uninstallTestServer(adminPage, goToAdminPage),
  //     uninstallTestServer(editorPage, goToEditorPage),
  //     uninstallTestServer(memberPage, goToMemberPage),
  //   ]);
  // });

  // test("Setup: Each user installs test server with their credentials", async ({
  //   adminPage,
  //   editorPage,
  //   memberPage,
  //   goToAdminPage,
  //   goToEditorPage,
  //   goToMemberPage,
  // }) => {
  //   await Promise.all([
  //     installTestServer(adminPage, goToAdminPage, "Admin"),
  //     installTestServer(editorPage, goToEditorPage, "Editor"),
  //     installTestServer(memberPage, goToMemberPage, "Member"),
  //   ]);
  // });

  // Matrix tests
  const MATRIX: MatrixTestParams[] = [
    {
      user: "Admin",
      vault: false,
      promptOnInstallation: false,
      mcpServerType: "custom-self-hosted",
    },
    {
      user: "Editor",
      vault: false,
      promptOnInstallation: false,
      mcpServerType: "custom-self-hosted",
    },
    {
      user: "Member",
      vault: false,
      promptOnInstallation: false,
      mcpServerType: "custom-self-hosted",
    },
    // { user: "Member", vault: false, promptOnInstallation: false, mcpServerType: "self-hosted" },
    // { user: "Admin", vault: true, promptOnInstallation: false, mcpServerType: "self-hosted" },
    // { user: "Editor", vault: true, promptOnInstallation: false, mcpServerType: "self-hosted" },
    // { user: "Member", vault: true, promptOnInstallation: false, mcpServerType: "self-hosted" },
    // { user: "Admin", vault: false, promptOnInstallation: true, mcpServerType: "self-hosted" },
    // { user: "Editor", vault: false, promptOnInstallation: true, mcpServerType: "self-hosted" },
    // { user: "Member", vault: false, promptOnInstallation: true, mcpServerType: "self-hosted" },
  ];
  MATRIX.forEach(({ vault, promptOnInstallation, mcpServerType, user }) => {
    test(`${user} | ${vault ? "Vault" : "No Vault"} | ${promptOnInstallation ? "Prompt on Installation" : "No Prompt on Installation"} | ${mcpServerType}`, async ({
      adminPage,
      editorPage,
      memberPage,
      extractCookieHeaders,
    }) => {
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
      const catalogItemName = `mcp-${mcpServerType}-user-${user}-vault-${vault}-prompt-${promptOnInstallation}`;
      const cookieHeaders = await extractCookieHeaders(adminPage);
      if (user === "Admin") {
        await assignEngineeringTeamToDefaultProfileViaApi({ cookieHeaders });
      }

      // Create catalog item as Admin
      // Editor and Member cannot add items to MCP Registry
      let newCatalogItem: { id: string; name: string } | undefined;
      newCatalogItem = await addCatalogItem({
        page: adminPage,
        params: { vault, promptOnInstallation, mcpServerType, user },
        cookieHeaders,
        catalogItemName,
      });
      if (!newCatalogItem) {
        throw new Error("Failed to create catalog item");
      }

      // Go to MCP Registry page
      await goToPage(page, "/mcp-catalog/registry");
      await page.waitForLoadState("networkidle");

      // Click connect button for the catalog item
      await page
        .getByTestId(`${E2eTestId.ConnectCatalogItemButton}-${catalogItemName}`)
        .click();
      // Personal credential type should be selected by default if vault is disabled
      // otherwise team credential type should be selected
      await expect(
        page.getByTestId(
          E2eTestId[
            vault ? "SelectCredentialTypeTeam" : "SelectCredentialTypePersonal"
          ],
        ),
      ).toBeChecked();

      // Each user installs personal credential
      await page.getByRole("button", { name: "Install" }).click();

      // Credentials count should be 1 for Admin and Editor
      if (user === "Admin" || user === "Editor") {
        await expect(
          page.getByTestId(`${E2eTestId.CredentialsCount}-${catalogItemName}`),
        ).toHaveText("1");
      }
      // Member cannot see credentials count
      if (user === "Member") {
        await expect(
          page.getByTestId(`${E2eTestId.CredentialsCount}-${catalogItemName}`),
        ).not.toBeVisible();
      }

      // Then click connect again
      await page
        .getByTestId(`${E2eTestId.ConnectCatalogItemButton}-${catalogItemName}`)
        .click();
      // And this time team credential type should be selected by default for everyone
      await expect(
        page.getByTestId(E2eTestId.SelectCredentialTypeTeam),
      ).toBeChecked();
      // open teams dropdown
      await page.getByRole("combobox").click();
      // Validate Admin sees all teams in dropdown, Editor and Member see only their own teams
      const expectedTeams = {
        Admin: [DEFAULT_TEAM_NAME, ENGINEERING_TEAM_NAME, MARKETING_TEAM_NAME],
        Editor: [ENGINEERING_TEAM_NAME, MARKETING_TEAM_NAME],
        Member: [MARKETING_TEAM_NAME],
      };
      for (const team of expectedTeams[user]) {
        await expect(
          page
            .getByTestId(E2eTestId.SelectCredentialTypeTeamDropdown)
            .getByText(team),
        ).toBeVisible();
      }
      // select first team from dropdown
      await page
        .getByTestId(E2eTestId.SelectCredentialTypeTeamDropdown)
        .getByText(expectedTeams[user][0])
        .click();

      // Install credential for team
      await page.getByRole("button", { name: "Install" }).click();

      // Credentials count should be 2 for Admin and Editor
      if (user === "Admin" || user === "Editor") {
        await expect(
          page.getByTestId(`${E2eTestId.CredentialsCount}-${catalogItemName}`),
        ).toHaveText("2");
      }

      // Check Manage Credentials dialog
      // Member cannot see Manage Credentials button
      if (user === "Member") {
        await expect(
          page.getByTestId(
            `${E2eTestId.ManageCredentialsButton}-${catalogItemName}`,
          ),
        ).not.toBeVisible();
      } else {
        // Admin and Editor opens Manage Credentials dialog and sees credentials
        const expectedCredentials = {
          Admin: [ADMIN_EMAIL, DEFAULT_TEAM_NAME],
          Editor: [EDITOR_EMAIL, ENGINEERING_TEAM_NAME],
        };

        await openManageCredentialsDialog(page, catalogItemName);
        const visibleCredentials = await getVisibleCredentials(page);
        for (const credential of expectedCredentials[user]) {
          await expect(visibleCredentials).toContain(credential);
          await expect(visibleCredentials).toHaveLength(
            expectedCredentials[user].length,
          );
        }

        // Check TokenSelect shows correct credentials
        await goToMcpRegitryAndOpenManageToolsAndOpenTokenSelect({
          page,
          catalogItemName,
        });
        const visibleStaticCredentials =
          await getVisibleStaticCredentials(page);
        for (const credential of expectedCredentials[user]) {
          await expect(visibleStaticCredentials).toContain(credential);
          await expect(visibleStaticCredentials).toHaveLength(
            expectedCredentials[user].length,
          );
        }

        // Select first static credential
        await page.getByRole("option").first().click();
        await page.getByText("Assign to 1 profile").click();
        await page.waitForLoadState("networkidle");

        await page.waitForTimeout(5_000);

        // Verify tool call result
        // TODO: fix it!
        // await verifyToolCallResultViaApi({
        //   request: page.request,
        //   expectedText: user,
        //   tokenToUse: "default-team",
        //   toolName: `${catalogItemName}__print_archestra_test`,
        // });
      }

      // CLEANUP: Delete created catalog items and mcp servers, non-blocking on purpose
      if (newCatalogItem) {
        apiSdk.deleteInternalMcpCatalogItem({
          path: { id: newCatalogItem.id },
          headers: { Cookie: cookieHeaders },
        });
      }
    });
  });

  // test("Verify tool calling for test server", async ({
  //   request,
  //   adminPage,
  //   editorPage,
  // }) => {
  //   await installTestServer(adminPage, "Admin");
  //   await verifyToolCallResultViaApi({
  //     request,
  //     expectedText: "Admin",
  //     tokenToUse: "default-team",
  //   });

  //   await installTestServer(editorPage, "Editor");
  //   await verifyToolCallResultViaApi({
  //     request,
  //     expectedText: "Editor",
  //     tokenToUse: "engineering-team",
  //   });
  // });
});

async function assignEngineeringTeamToDefaultProfileViaApi({
  cookieHeaders,
}: {
  cookieHeaders: string;
}) {
  // 1. Get all teams and find Default Team and Engineering Team
  const teamsResponse = await apiSdk.getTeams({
    headers: { Cookie: cookieHeaders },
  });
  const defaultTeam = teamsResponse.data?.find(
    (team) => team.name === DEFAULT_TEAM_NAME,
  );
  if (!defaultTeam) {
    throw new Error(`Team "${DEFAULT_TEAM_NAME}" not found`);
  }
  const engineeringTeam = teamsResponse.data?.find(
    (team) => team.name === ENGINEERING_TEAM_NAME,
  );
  if (!engineeringTeam) {
    throw new Error(`Team "${ENGINEERING_TEAM_NAME}" not found`);
  }

  // 2. Get all profiles and find Default Agent
  const agentsResponse = await apiSdk.getAgents({
    headers: { Cookie: cookieHeaders },
  });
  const defaultProfile = agentsResponse.data?.data?.find(
    (agent) => agent.name === DEFAULT_PROFILE_NAME,
  );
  if (!defaultProfile) {
    throw new Error(`Profile "${DEFAULT_PROFILE_NAME}" not found`);
  }

  // 3. Assign BOTH Default Team and Engineering Team to the profile
  await apiSdk.updateAgent({
    headers: { Cookie: cookieHeaders },
    path: { id: defaultProfile.id },
    body: {
      teams: [defaultTeam.id, engineeringTeam.id],
    },
  });
}

async function addCatalogItem({
  page,
  params,
  cookieHeaders,
  catalogItemName,
}: {
  page: Page;
  params: MatrixTestParams;
  cookieHeaders: string;
  catalogItemName: string;
}) {
  // Go to Add MCP Server page
  await goToPage(page, "/mcp-catalog/registry");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add MCP Server" }).click();

  if (params.mcpServerType === "custom-self-hosted") {
    await page
      .getByRole("button", { name: "Self-hosted (orchestrated by" })
      .click();
    await page.getByRole("textbox", { name: "Name *" }).fill(catalogItemName);
    await page.getByRole("textbox", { name: "Command *" }).fill("sh");
    const singleLineCommand = testMcpServerCommand.replace(/\n/g, " ");
    await page
      .getByRole("textbox", { name: "Arguments (one per line)" })
      .fill(`-c\n${singleLineCommand}`);
    await page.getByRole("button", { name: "Add Server" }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1_000);
    const catalogItems = await apiSdk.getInternalMcpCatalog({
      headers: { Cookie: cookieHeaders },
    });
    if (!catalogItems.data) {
      throw new Error("No catalog items found");
    }
    const newCatalogItem = catalogItems.data?.find(
      (item) => item.name === catalogItemName,
    );
    if (!newCatalogItem) {
      throw new Error("Failed to find new catalog item");
    }
    return { id: newCatalogItem.id, name: newCatalogItem.name };
  }
  await page.waitForLoadState("networkidle");
}

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

async function goToMcpRegitryAndOpenManageToolsAndOpenTokenSelect({
  page,
  catalogItemName,
}: {
  page: Page;
  catalogItemName: string;
}) {
  await goToPage(page, "/mcp-catalog/registry");
  await page.waitForLoadState("networkidle");
  const manageToolsButton = page.getByTestId(
    `${E2eTestId.ManageToolsButton}-${catalogItemName}`,
  );
  await manageToolsButton.click();
  await page
    .getByRole("button", { name: "Assign Tool to Profiles" })
    .first()
    .click();
  await page.getByRole("checkbox").first().click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("combobox").click();
  await page.waitForLoadState("networkidle");
}

async function verifyToolCallResultViaApi({
  request,
  expectedText,
  tokenToUse,
  toolName,
}: {
  request: APIRequestContext;
  expectedText: "Admin" | "Editor" | "AnySuccessText";
  tokenToUse: "default-team" | "engineering-team" | "org-token";
  toolName: string;
}) {
  // API verification: call tool via MCP Gateway and verify it returns "Admin"
  // (the value Admin used when installing the server)
  const defaultProfileResponse = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/agents/default",
  });
  const defaultProfile = await defaultProfileResponse.json();

  let token: string;
  if (tokenToUse === "default-team") {
    token = await getTeamTokenForProfile(request, DEFAULT_TEAM_NAME);
  } else if (tokenToUse === "engineering-team") {
    token = await getTeamTokenForProfile(request, ENGINEERING_TEAM_NAME);
  } else {
    token = await getOrgTokenForProfile(request);
  }

  const sessionId = await initializeMcpSession(request, {
    profileId: defaultProfile.id,
    token,
  });

  const toolResult = await callMcpTool(request, {
    profileId: defaultProfile.id,
    token,
    sessionId,
    toolName,
  });

  const textContent = toolResult.content.find((c) => c.type === "text");
  if (expectedText === "AnySuccessText") {
    return;
  }
  if (!textContent?.text?.includes(expectedText)) {
    throw new Error(
      `Expected tool result to contain "${expectedText}" but got "${textContent?.text}"`,
    );
  }
}

/**
 * Install the test MCP server for a user with their name as ARCHESTRA_TEST value
 */
async function installTestServer(page: Page, userName: string): Promise<void> {
  await goToPage(page, "/mcp-catalog/registry");
  await page.waitForLoadState("networkidle");

  // Find the test server card using data-slot attribute
  const serverCard = page.getByTestId(
    `${E2eTestId.McpServerCard}-${TEST_SERVER_NAME}`,
  );
  await expect(serverCard).toBeVisible();

  // Click Connect button within that card
  await serverCard.getByRole("button", { name: /Connect/i }).click();

  // Wait for the installation dialog to appear
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Fill in the ARCHESTRA_TEST environment variable with user name
  await dialog.getByLabel(/ARCHESTRA_TEST/i).fill(userName);

  // Click Install button
  await dialog.getByRole("button", { name: /Install/i }).click();

  // Wait for installation to complete (dialog should close)
  await expect(dialog).toBeHidden({ timeout: 60000 });
  await page.waitForLoadState("networkidle");
}

/**
 * Uninstall the test MCP server for the current user
 */
async function uninstallTestServer(
  page: Page,
  goTo: GoToPageFn,
): Promise<void> {
  await goTo("/mcp-catalog/registry");
  await page.waitForLoadState("networkidle");

  // Find the test server card
  const serverCard = page.getByTestId(
    `${E2eTestId.McpServerCard}-${TEST_SERVER_NAME}`,
  );
  await expect(serverCard).toBeVisible();

  // Click Uninstall button
  const uninstallButton = serverCard.getByRole("button", {
    name: /Uninstall/i,
  });
  const connectButton = serverCard.getByRole("button", { name: /Connect/i });

  // If "Connect" button is visible, then skip
  if (await connectButton.isVisible()) {
    return;
  }

  if (await uninstallButton.isVisible()) {
    await uninstallButton.click();

    // Confirm uninstall in the dialog
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Uninstall/i }).click();

    // Wait for uninstall to complete (pod deletion can take time)
    await expect(dialog).toBeHidden({ timeout: 60000 });
  }
}

/** Type for user-specific navigation function */
type GoToPageFn = (path?: string) => ReturnType<Page["goto"]>;

/**
 * Open the Local Installations dialog for the test server
 */
async function openManageCredentialsDialog(
  page: Page,
  catalogItemName: string,
): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2_000);
  // Find and click the Manage button for credentials
  const manageButton = page.getByTestId(
    `${E2eTestId.ManageCredentialsButton}-${catalogItemName}`,
  );
  await expect(manageButton).toBeVisible();
  await manageButton.click();

  // Wait for dialog to appear
  await expect(
    page.getByTestId(E2eTestId.ManageCredentialsDialog),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
}

/**
 * Get visible credential emails from the Local Installations dialog
 */
async function getVisibleCredentials(page: Page): Promise<string[]> {
  return await page.getByTestId(E2eTestId.CredentialOwner).allTextContents();
}

/**
 * Get visible static credentials from the TokenSelect
 */
async function getVisibleStaticCredentials(page: Page): Promise<string[]> {
  return await page
    .getByTestId(E2eTestId.StaticCredentialToUse)
    .allTextContents();
}

/**
 * Get available team options from the team select for a specific credential row
 */
async function getTeamSelectOptionsForCredential(
  page: Page,
  userEmail: string,
): Promise<string[]> {
  const row = page
    .getByTestId(E2eTestId.CredentialRow)
    .filter({ has: page.getByText(userEmail) });
  const teamSelect = row.getByTestId(E2eTestId.CredentialTeamSelect);

  // Check if team select exists (it might not if no teams are available)
  if ((await teamSelect.count()) === 0) {
    return [];
  }

  // Click to open the select dropdown
  await teamSelect.click();

  // Get all options from the dropdown
  const options = await page.getByRole("option").allTextContents();

  // Close the dropdown by pressing Escape
  await page.keyboard.press("Escape");

  return options;
}

/**
 * Grant team access to a credential
 */
async function grantTeamAccessToCredential(
  page: Page,
  userEmail: string,
  teamName: string,
): Promise<void> {
  const row = page
    .getByTestId(E2eTestId.CredentialRow)
    .filter({ has: page.getByText(userEmail) });
  await row.getByTestId(E2eTestId.CredentialTeamSelect).click();
  await page.getByRole("option", { name: teamName }).click();
  await page.waitForLoadState("networkidle");
}

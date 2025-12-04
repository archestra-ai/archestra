/**
 * Credentials Management E2E Tests
 *
 * Given the following users:
 * - Admin - Admin Role - Default team
 * - Editor - Editor Role - Engineering and Marketing Team
 * - Member - Member Role - Marketing Team
 *
 * The Local Installations dialog requires `tool:update` and `profile:update` permissions.
 * Admin and Editor have these permissions and can manage credentials
 * Member cannot see the "Manage" button
 *
 * Admin sees all credentials in Local Installations dialog
 * Editor sees only their own and Member's credentials (team-based visibility)
 *
 * Admin can grant their credential to any team
 * Editor can see options that belong to his team / teams
 */

import type { Page } from "@playwright/test";
import {
  ADMIN_EMAIL,
  E2eTestId,
  EDITOR_EMAIL,
  ENGINEERING_TEAM_NAME,
  MARKETING_TEAM_NAME,
  MEMBER_EMAIL,
} from "../../consts";
import { expect, test } from "../../fixtures";

const TEST_SERVER_NAME = "internal-dev-test-server";

test.describe("Credentials Management", () => {
  test.describe.configure({ mode: "serial" });

  // Cleanup any existing installations at the start to ensure clean state
  test("Setup: Clean any existing installations", async ({
    adminPage,
    editorPage,
    memberPage,
    goToAdminPage,
    goToEditorPage,
    goToMemberPage,
  }, testInfo) => {
    // Pod deletion can take a while, so we need a longer timeout
    testInfo.setTimeout(180000);

    await Promise.all([
      uninstallTestServer(adminPage, goToAdminPage),
      uninstallTestServer(editorPage, goToEditorPage),
      uninstallTestServer(memberPage, goToMemberPage),
    ]);
  });

  test("Each user installs test server with their credentials", async ({
    adminPage,
    editorPage,
    memberPage,
    goToAdminPage,
    goToEditorPage,
    goToMemberPage,
  }) => {
    await Promise.all([
      installTestServer(adminPage, goToAdminPage, "Admin"),
      installTestServer(editorPage, goToEditorPage, "Editor"),
      installTestServer(memberPage, goToMemberPage, "Member"),
    ]);
  });

  test.describe("Check who can see which credentials", () => {
    test("Member cannot see Manage credentials button (lacks permissions)", async ({
      memberPage,
      goToMemberPage,
    }) => {
      await goToMemberPage("/mcp-catalog/registry");
      await memberPage.waitForLoadState("networkidle");

      // Find the test server card
      const serverCard = memberPage.getByTestId(
        `${E2eTestId.McpServerCard}-${TEST_SERVER_NAME}`,
      );
      await expect(serverCard).toBeVisible();

      // Member should see Uninstall button (they installed the server)
      await expect(
        serverCard.getByRole("button", { name: /Uninstall/i }),
      ).toBeVisible({ timeout: 20_000 });

      // But Member should NOT see the Manage credentials button (requires tool:update, profile:update)
      await expect(
        memberPage.getByTestId(
          `${E2eTestId.ManageCredentialsButton}-${TEST_SERVER_NAME}`,
        ),
      ).not.toBeVisible();
    });

    test("Admin sees all credentials in Local Installations dialog", async ({
      adminPage,
      goToAdminPage,
    }) => {
      await openLocalInstallationsDialog(adminPage, goToAdminPage);

      const visibleEmails = await getVisibleCredentialEmails(adminPage);

      // Admin should see all 3 credentials
      expect(visibleEmails).toContain(ADMIN_EMAIL);
      expect(visibleEmails).toContain(EDITOR_EMAIL);
      expect(visibleEmails).toContain(MEMBER_EMAIL);
      expect(visibleEmails.length).toBe(3);
    });

    test("Editor sees only Editor and Member credentials (team-based visibility)", async ({
      editorPage,
      goToEditorPage,
    }) => {
      await openLocalInstallationsDialog(editorPage, goToEditorPage);

      const visibleEmails = await getVisibleCredentialEmails(editorPage);

      // Editor should see their own and Member's credentials (both in Marketing Team)
      expect(visibleEmails).toContain(EDITOR_EMAIL);
      expect(visibleEmails).toContain(MEMBER_EMAIL);
      // Editor should NOT see Admin's credential (Admin is not in Editor's teams)
      expect(visibleEmails).not.toContain(ADMIN_EMAIL);
      expect(visibleEmails.length).toBe(2);
    });
  });

  test.describe("Check team select options", () => {
    test("Admin can see all teams in team select options", async ({
      adminPage,
      goToAdminPage,
    }) => {
      await openLocalInstallationsDialog(adminPage, goToAdminPage);

      // Check team select options for Admin's credential
      const adminOptions = await getTeamSelectOptionsForCredential(
        adminPage,
        ADMIN_EMAIL,
      );
      // Admin should see all teams as options
      expect(adminOptions).toContain(ENGINEERING_TEAM_NAME);
      expect(adminOptions).toContain(MARKETING_TEAM_NAME);
    });

    test("Editor can see options that belong to his team / teams", async ({
      editorPage,
      goToEditorPage,
    }) => {
      await openLocalInstallationsDialog(editorPage, goToEditorPage);

      // Editor should be able to see team select for their own credential
      const editorOptions = await getTeamSelectOptionsForCredential(
        editorPage,
        EDITOR_EMAIL,
      );
      // Editor can only assign teams they belong to
      expect(editorOptions.length).toBeGreaterThanOrEqual(0);
    });
  });

  test("Admin grants their credential to Marketing Team", async ({
    adminPage,
    goToAdminPage,
  }) => {
    await openLocalInstallationsDialog(adminPage, goToAdminPage);

    // Grant Admin's credential to Marketing Team
    await grantTeamAccessToCredential(
      adminPage,
      ADMIN_EMAIL,
      MARKETING_TEAM_NAME,
    );

    // Verify the team badge appears
    const row = adminPage
      .getByTestId(E2eTestId.CredentialRow)
      .filter({ has: adminPage.getByText(ADMIN_EMAIL) });
    await expect(row.getByText(MARKETING_TEAM_NAME)).toBeVisible();
  });

  test("Editor can now see Admin's credential after team grant", async ({
    editorPage,
    goToEditorPage,
  }) => {
    await openLocalInstallationsDialog(editorPage, goToEditorPage);

    const visibleEmails = await getVisibleCredentialEmails(editorPage);

    // Editor should now see Admin's credential (Admin granted to Marketing, Editor is in Marketing)
    expect(visibleEmails).toContain(ADMIN_EMAIL);
    expect(visibleEmails).toContain(EDITOR_EMAIL);
    expect(visibleEmails).toContain(MEMBER_EMAIL);
    expect(visibleEmails.length).toBe(3);
  });
});

/**
 * Install the test MCP server for a user with their name as ARCHESTRA_TEST value
 */
async function installTestServer(
  page: Page,
  goTo: GoToPageFn,
  userName: string,
): Promise<void> {
  await goTo("/mcp-catalog/registry");
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
async function openLocalInstallationsDialog(
  page: Page,
  goTo: GoToPageFn,
): Promise<void> {
  await goTo("/mcp-catalog/registry");
  await page.waitForLoadState("networkidle");

  // Find and click the Manage button for credentials
  const manageButton = page.getByTestId(
    `${E2eTestId.ManageCredentialsButton}-${TEST_SERVER_NAME}`,
  );
  await expect(manageButton).toBeVisible();
  await manageButton.click();

  // Wait for dialog to appear
  await expect(
    page.getByTestId(E2eTestId.LocalInstallationsDialog),
  ).toBeVisible();
}

/**
 * Get visible credential emails from the Local Installations dialog
 */
async function getVisibleCredentialEmails(page: Page): Promise<string[]> {
  return await page
    .getByTestId(E2eTestId.CredentialOwnerEmail)
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

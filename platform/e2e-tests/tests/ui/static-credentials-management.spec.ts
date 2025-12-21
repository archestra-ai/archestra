import type { Page } from "@playwright/test";
import { archestraApiSdk } from "@shared";
import {
  ADMIN_EMAIL,
  DEFAULT_TEAM_NAME,
  E2eTestId,
  EDITOR_EMAIL,
  ENGINEERING_TEAM_NAME,
  MARKETING_TEAM_NAME,
} from "../../consts";
import { expect, goToPage, test } from "../../fixtures";
import {
  addCustomSelfHostedCatalogItem,
  assignEngineeringTeamToDefaultProfileViaApi,
  clickButton,
  getVisibleCredentials,
  getVisibleStaticCredentials,
  goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect,
  openManageCredentialsDialog,
  verifyToolCallResultViaApi,
} from "../../utils";

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
      test.setTimeout(45_000); // 45 seconds
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
      const catalogItemName = makeRandomString(10, "mcp");
      if (user === "Admin") {
        await assignEngineeringTeamToDefaultProfileViaApi({ cookieHeaders });
      }

      // Create catalog item as Admin
      // Editor and Member cannot add items to MCP Registry
      let newCatalogItem: { id: string; name: string } | undefined;
      newCatalogItem = await addCustomSelfHostedCatalogItem({
        page: adminPage,
        cookieHeaders,
        catalogItemName,
      });

      // Go to MCP Registry page
      await goToPage(page, "/mcp-catalog/registry");
      await page.waitForLoadState("networkidle");

      // Click connect button for the catalog item
      await page
        .getByTestId(`${E2eTestId.ConnectCatalogItemButton}-${catalogItemName}`)
        .click();
      await page.waitForLoadState("networkidle");
      // Personal credential type should be selected by default if vault is disabled
      // otherwise team credential type should be selected
      await expect(
        page.getByTestId(E2eTestId.SelectCredentialTypePersonal),
      ).toBeChecked();

      // Install using personal credential
      await clickButton({ page, options: { name: "Install" } });

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
      await clickButton({ page, options: { name: "Install" } });

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
        await goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect({
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

        // Then we revoke first credential in Manage Credentials dialog, then close dialog
        await goToPage(page, "/mcp-catalog/registry");
        await openManageCredentialsDialog(page, catalogItemName);
        await clickButton({ page, options: { name: "Revoke" }, first: true });
        await page.waitForLoadState("networkidle");
        await clickButton({ page, options: { name: "Close" }, nth: 1 });

        // And we check that the credential is revoked
        // Use polling to handle async credential revocation in CI
        const expectedCredentialsAfterRevoke = {
          Admin: [ADMIN_EMAIL, DEFAULT_TEAM_NAME],
          Editor: [EDITOR_EMAIL, ENGINEERING_TEAM_NAME],
        };
        const expectedLengthAfterRevoke =
          expectedCredentialsAfterRevoke[user].length - 1;

        await expect(async () => {
          await goToPage(page, "/mcp-catalog/registry");
          await openManageCredentialsDialog(page, catalogItemName);
          const visibleCredentialsAfterRevoke =
            await getVisibleCredentials(page);
          expect(visibleCredentialsAfterRevoke).toHaveLength(
            expectedLengthAfterRevoke,
          );
        }).toPass({ timeout: 15_000, intervals: [1000, 2000, 3000] });
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
  test.setTimeout(45_000); // 45 seconds
  // Create catalog item as Admin
  // Editor and Member cannot add items to MCP Registry
  const catalogItemName = makeRandomString(10, "mcp");
  const cookieHeaders = await extractCookieHeaders(adminPage);
  const newCatalogItem = await addCustomSelfHostedCatalogItem({
    page: adminPage,
    cookieHeaders,
    catalogItemName,
  });
  const MATRIX = [
    { user: "Admin", page: adminPage },
    { user: "Editor", page: editorPage },
    { user: "Member", page: memberPage },
  ] as const;

  const install = async (page: Page) => {
    // Go to MCP Registry page
    await goToPage(page, "/mcp-catalog/registry");
    await page.waitForLoadState("networkidle");
    // Click connect button for the catalog item
    await page
      .getByTestId(`${E2eTestId.ConnectCatalogItemButton}-${catalogItemName}`)
      .click();
    // Install using personal credential
    await clickButton({ page, options: { name: "Install" } });
    // Wait for dialog to close and button to be visible again
    const connectButton = page.getByTestId(
      `${E2eTestId.ConnectCatalogItemButton}-${catalogItemName}`,
    );
    await connectButton.waitFor({ state: "visible" });
    await connectButton.click();
    // And this time team credential type should be selected by default for everyone, install using team credential
    await clickButton({ page, options: { name: "Install" } });
    await page.waitForLoadState("networkidle");
  };

  // Each user adds personal and 1 team credential
  await Promise.all(MATRIX.map(({ page }) => install(page)));

  // Check Credentials counter
  const checkCredentialsCount = async (
    page: Page,
    user: "Admin" | "Editor" | "Member",
  ) => {
    await goToPage(page, "/mcp-catalog/registry");
    await page.waitForLoadState("networkidle");
    const expectedCredentialsCount = {
      Admin: 6, // admin sees all credentials
      Editor: 3, // editor sees their own credentials + additional Marketing team credential added by member
    };
    // Member cannot see credentials count
    if (user === "Member") {
      return;
    }
    await expect(
      page.getByTestId(`${E2eTestId.CredentialsCount}-${catalogItemName}`),
    ).toHaveText(expectedCredentialsCount[user].toString());
  };
  await Promise.all(
    MATRIX.map(({ page, user }) => checkCredentialsCount(page, user)),
  );

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
  test.setTimeout(45_000); // 45 seconds
  const CATALOG_ITEM_NAME = makeRandomString(10, "mcp");
  const cookieHeaders = await extractCookieHeaders(adminPage);
  // Assign engineering team to default profile
  await assignEngineeringTeamToDefaultProfileViaApi({ cookieHeaders });
  // Create catalog item as Admin
  // Editor and Member cannot add items to MCP Registry
  const newCatalogItem = await addCustomSelfHostedCatalogItem({
    page: adminPage,
    cookieHeaders,
    catalogItemName: CATALOG_ITEM_NAME,
    envVars: {
      key: "ARCHESTRA_TEST",
      promptOnInstallation: true,
    },
  });
  if (!newCatalogItem) {
    throw new Error("Failed to create catalog item");
  }

  // Install test server for admin
  await adminPage
    .getByTestId(`${E2eTestId.ConnectCatalogItemButton}-${CATALOG_ITEM_NAME}`)
    .click();
  await adminPage
    .getByRole("textbox", { name: "ARCHESTRA_TEST" })
    .fill("Admin-personal-credential");
  await clickButton({ page: adminPage, options: { name: "Install" } });
  await adminPage.waitForLoadState("networkidle");

  // Install test server for editor
  await goToPage(editorPage, "/mcp-catalog/registry");
  await editorPage
    .getByTestId(`${E2eTestId.ConnectCatalogItemButton}-${CATALOG_ITEM_NAME}`)
    .click();
  await editorPage
    .getByRole("textbox", { name: "ARCHESTRA_TEST" })
    .fill("Editor-personal-credential");
  await clickButton({ page: editorPage, options: { name: "Install" } });
  await editorPage.waitForLoadState("networkidle");

  // Assign tool to profiles using admin static credential
  await goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect({
    page: adminPage,
    catalogItemName: CATALOG_ITEM_NAME,
  });
  // Select admin static credential
  await adminPage.getByRole("option", { name: "admin@example.com" }).click();
  await adminPage.getByText("Assign to 1 profile").click();
  await adminPage.waitForLoadState("networkidle");
  // Verify tool call result using admin static credential
  await verifyToolCallResultViaApi({
    request,
    expectedResult: "Admin-personal-credential",
    tokenToUse: "org-token",
    toolName: `${CATALOG_ITEM_NAME}__print_archestra_test`,
    cookieHeaders,
  });

  // Assign tool to profiles using editor static credential
  await goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect({
    page: editorPage,
    catalogItemName: CATALOG_ITEM_NAME,
  });
  // Select editor static credential
  await editorPage.getByRole("option", { name: "editor@example.com" }).click();
  await editorPage.getByText("Assign to 1 profile").click();
  await editorPage.waitForLoadState("networkidle");
  // Verify tool call result using editor static credential
  await verifyToolCallResultViaApi({
    request,
    expectedResult: "Editor-personal-credential",
    tokenToUse: "org-token",
    toolName: `${CATALOG_ITEM_NAME}__print_archestra_test`,
    cookieHeaders,
  });

  // CLEANUP: Delete existing created MCP servers / installations
  await archestraApiSdk.deleteInternalMcpCatalogItem({
    path: { id: newCatalogItem.id },
    headers: { Cookie: cookieHeaders },
  });
});

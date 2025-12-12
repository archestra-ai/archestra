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
} from "../../consts";
import { expect, goToPage, test } from "../../fixtures";
import {
  callMcpTool,
  getOrgTokenForProfile,
  getTeamTokenForProfile,
  initializeMcpSession,
} from "../api/mcp-gateway-utils";

const TEST_CATALOG_ITEM_NAME = "internal-dev-test-server";
const TEST_TOOL_NAME = `${TEST_CATALOG_ITEM_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}print_archestra_test`;

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

test.describe("Credentials Management", () => {
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
      }

      // CLEANUP: Delete created catalog items and mcp servers, non-blocking on purpose
      if (newCatalogItem) {
        await apiSdk.deleteInternalMcpCatalogItem({
          path: { id: newCatalogItem.id },
          headers: { Cookie: cookieHeaders },
        });
      }
    });
  });

  test("Verify tool calling using different static credentials", async ({
    request,
    adminPage,
    editorPage,
    extractCookieHeaders,
  }) => {
    const cookieHeaders = await extractCookieHeaders(adminPage);

    // CLEANUP: Delete existingcreated MCP servers / installations
    await goToPage(adminPage, "/mcp-catalog/registry");
    await openManageCredentialsDialog(adminPage, TEST_CATALOG_ITEM_NAME);
    const count = await adminPage
      .getByRole("button", { name: "Revoke" })
      .count();
    for (let i = 0; i < count; i++) {
      await adminPage.getByRole("button", { name: "Revoke" }).first().click();
    }

    // Install test servers
    await Promise.all([
      installTestServer(adminPage, "Admin"),
      installTestServer(editorPage, "Editor"),
    ]);

    await goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect({
      page: adminPage,
      catalogItemName: TEST_CATALOG_ITEM_NAME,
    });
    // Select admin static credential
    await adminPage.getByRole("option", { name: "admin@example.com" }).click();
    await adminPage.getByText("Assign to 1 profile").click();
    await adminPage.waitForLoadState("networkidle");

    // Verify tool call result using admin static credential
    await verifyToolCallResultViaApi({
      request,
      expectedText: "Admin",
      tokenToUse: "org-token",
      toolName: `${TEST_CATALOG_ITEM_NAME}__print_archestra_test`,
      cookieHeaders,
    });

    await goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect({
      page: adminPage,
      catalogItemName: TEST_CATALOG_ITEM_NAME,
    });
    // Select editor static credential
    await adminPage.getByRole("option", { name: "editor@example.com" }).click();
    await adminPage.getByText("Assign to 1 profile").click();
    await adminPage.waitForLoadState("networkidle");

    // Verify tool call result using editor static credential
    await verifyToolCallResultViaApi({
      request,
      expectedText: "Editor",
      tokenToUse: "org-token",
      toolName: TEST_TOOL_NAME,
      cookieHeaders,
    });
  });
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

async function goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect({
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
  cookieHeaders,
}: {
  request: APIRequestContext;
  expectedText: "Admin" | "Editor" | "AnySuccessText";
  tokenToUse: "default-team" | "engineering-team" | "org-token";
  toolName: string;
  cookieHeaders: string;
}) {
  const { data: defaultProfile } = await apiSdk.getDefaultAgent({
    headers: { Cookie: cookieHeaders },
  });
  if (!defaultProfile) {
    throw new Error("Default profile not found");
  }

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
    `${E2eTestId.McpServerCard}-${TEST_CATALOG_ITEM_NAME}`,
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

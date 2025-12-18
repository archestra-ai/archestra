import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { archestraApiSdk } from "@shared";
import { testMcpServerCommand } from "@shared/test-mcp-server";
import {
  DEFAULT_PROFILE_NAME,
  DEFAULT_TEAM_NAME,
  E2eTestId,
  ENGINEERING_TEAM_NAME,
  MARKETING_TEAM_NAME,
  UI_BASE_URL,
} from "./consts";
import { goToPage } from "./fixtures";
import {
  callMcpTool,
  getOrgTokenForProfile,
  getTeamTokenForProfile,
  initializeMcpSession,
} from "./tests/api/mcp-gateway-utils";

export async function addCustomSelfHostedCatalogItem({
  page,
  cookieHeaders,
  catalogItemName,
  envVars,
}: {
  page: Page;
  cookieHeaders: string;
  catalogItemName: string;
  envVars?: {
    key: string;
    promptOnInstallation: boolean;
    isSecret?: boolean;
    vaultSecret?: {
      name: string;
      key: string;
      value: string;
      teamName: string;
    };
  };
}) {
  await goToPage(page, "/mcp-catalog/registry");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add MCP Server" }).click();

  await page
    .getByRole("button", { name: "Self-hosted (orchestrated by" })
    .click();
  await page.getByRole("textbox", { name: "Name *" }).fill(catalogItemName);
  await page.getByRole("textbox", { name: "Command *" }).fill("sh");
  const singleLineCommand = testMcpServerCommand.replace(/\n/g, " ");
  await page
    .getByRole("textbox", { name: "Arguments (one per line)" })
    .fill(`-c\n${singleLineCommand}`);
  if (envVars) {
    await page.getByRole("button", { name: "Add Variable" }).click();
    await page.getByRole("textbox", { name: "API_KEY" }).fill(envVars.key);
    if (envVars.isSecret) {
      await page.getByTestId(E2eTestId.SelectEnvironmentVariableType).click();
      await page.getByRole("option", { name: "Secret" }).click();
    }
    if (envVars.promptOnInstallation) {
      await page
        .getByTestId(E2eTestId.PromptOnInstallationCheckbox)
        .click({ force: true });
    }
    if (envVars.vaultSecret) {
      await page.getByText("Set Secret").click();
      await page
        .getByTestId(E2eTestId.ExternalSecretSelectorTeamTrigger)
        .click();
      await page
        .getByRole("option", { name: envVars.vaultSecret.teamName })
        .click();
      await page
        .getByTestId(E2eTestId.ExternalSecretSelectorSecretTrigger)
        .click();
      await page.getByText(envVars.vaultSecret.name).click();
      await page
        .getByTestId(E2eTestId.ExternalSecretSelectorSecretTriggerKey)
        .click();
      await page.getByRole("option", { name: envVars.vaultSecret.key }).click();
      await page.getByRole("button", { name: "Confirm" }).click();
      await page.waitForTimeout(2_000);
    }
  }
  await page.getByRole("button", { name: "Add Server" }).click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1_000);
  const catalogItems = await archestraApiSdk.getInternalMcpCatalog({
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

export async function goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect({
  page,
  catalogItemName,
}: {
  page: Page;
  catalogItemName: string;
}) {
  await goToPage(page, "/mcp-catalog/registry");
  await page.waitForLoadState("networkidle");

  // Verify we're actually on the registry page (handle redirect issues)
  await expect(page).toHaveURL(/\/mcp-catalog\/registry/, { timeout: 10000 });

  // Poll for manage-tools button to appear (MCP tool discovery is async)
  // After installing, the server needs to: start → connect → discover tools → save to DB
  const manageToolsButton = page.getByTestId(
    `${E2eTestId.ManageToolsButton}-${catalogItemName}`,
  );

  await expect(async () => {
    // Re-navigate in case the page got stale
    await page.goto(`${UI_BASE_URL}/mcp-catalog/registry`);
    await page.waitForLoadState("networkidle");
    await expect(manageToolsButton).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 60_000, intervals: [3000, 5000, 7000, 10000] });

  await manageToolsButton.click();
  await page
    .getByRole("button", { name: "Assign Tool to Profiles" })
    .first()
    .click();
  await page.getByRole("checkbox").first().click();
  await page.waitForLoadState("networkidle");
  const combobox = page.getByRole("combobox");
  await combobox.waitFor({ state: "visible" });
  await combobox.click();
  // Wait a brief moment for dropdown to open (dropdowns are client-side, no network request needed)
  await page.waitForTimeout(100);
}

export async function verifyToolCallResultViaApi({
  request,
  expectedResult,
  tokenToUse,
  toolName,
  cookieHeaders,
}: {
  request: APIRequestContext;
  expectedResult:
    | "Admin-personal-credential"
    | "Editor-personal-credential"
    | "Member-personal-credential"
    | "Default-team-credential"
    | "Engineering-team-credential"
    | "Marketing-team-credential"
    | "AnySuccessText"
    | "Error";
  tokenToUse:
    | "default-team"
    | "engineering-team"
    | "marketing-team"
    | "org-token";
  toolName: string;
  cookieHeaders: string;
}) {
  const { data: defaultProfile } = await archestraApiSdk.getDefaultAgent({
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
  } else if (tokenToUse === "marketing-team") {
    token = await getTeamTokenForProfile(request, MARKETING_TEAM_NAME);
  } else {
    token = await getOrgTokenForProfile(request);
  }

  let toolResult: Awaited<ReturnType<typeof callMcpTool>>;

  try {
    const sessionId = await initializeMcpSession(request, {
      profileId: defaultProfile.id,
      token,
    });

    toolResult = await callMcpTool(request, {
      profileId: defaultProfile.id,
      token,
      sessionId,
      toolName,
    });
  } catch (error) {
    if (expectedResult === "Error") {
      return;
    }
    throw error;
  }

  const textContent = toolResult.content.find((c) => c.type === "text");
  if (expectedResult === "AnySuccessText") {
    return;
  }

  if (
    !textContent?.text?.includes(expectedResult) &&
    expectedResult !== "Error"
  ) {
    throw new Error(
      `Expected tool result to contain "${expectedResult}" but got "${textContent?.text}"`,
    );
  }
}

/**
 * Open the Local Installations dialog for the test server
 */
export async function openManageCredentialsDialog(
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
export async function getVisibleCredentials(page: Page): Promise<string[]> {
  return await page.getByTestId(E2eTestId.CredentialOwner).allTextContents();
}

/**
 * Get visible static credentials from the TokenSelect
 */
export async function getVisibleStaticCredentials(
  page: Page,
): Promise<string[]> {
  return await page
    .getByTestId(E2eTestId.StaticCredentialToUse)
    .allTextContents();
}

/**
 * Assign Engineering Team to Default Profile
 */
export async function assignEngineeringTeamToDefaultProfileViaApi({
  cookieHeaders,
}: {
  cookieHeaders: string;
}) {
  // 1. Get all teams and find Default Team and Engineering Team
  const teamsResponse = await archestraApiSdk.getTeams({
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
  const agentsResponse = await archestraApiSdk.getAgents({
    headers: { Cookie: cookieHeaders },
  });
  const defaultProfile = agentsResponse.data?.data?.find(
    (agent) => agent.name === DEFAULT_PROFILE_NAME,
  );
  if (!defaultProfile) {
    throw new Error(`Profile "${DEFAULT_PROFILE_NAME}" not found`);
  }

  // 3. Assign BOTH Default Team and Engineering Team to the profile
  await archestraApiSdk.updateAgent({
    headers: { Cookie: cookieHeaders },
    path: { id: defaultProfile.id },
    body: {
      teams: [defaultTeam.id, engineeringTeam.id],
    },
  });
}

export async function clickButton({
  page,
  options,
  first,
  nth,
}: {
  page: Page;
  options: Parameters<Page["getByRole"]>[1];
  first?: boolean;
  nth?: number;
}) {
  let button = page.getByRole("button", {
    disabled: false,
    ...options,
  });

  if (first) {
    button = button.first();
  } else if (nth !== undefined) {
    button = button.nth(nth);
  }

  return await button.click();
}

/**
 * Login via API (bypasses UI form for reliability).
 * Handles rate limiting with exponential backoff retry.
 *
 * @param page - Playwright page (uses page.request for API calls)
 * @param email - User email
 * @param password - User password
 * @param maxRetries - Maximum number of retries (default 3)
 * @returns true if login succeeded
 */
export async function loginViaApi(
  page: Page,
  email: string,
  password: string,
  maxRetries = 3,
): Promise<boolean> {
  let delay = 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await page.request.post(
      `${UI_BASE_URL}/api/auth/sign-in/email`,
      {
        data: { email, password },
        headers: { Origin: UI_BASE_URL },
      },
    );

    if (response.ok()) {
      return true;
    }

    // If rate limited or server error, wait and retry
    if (
      (response.status() === 429 || response.status() >= 500) &&
      attempt < maxRetries
    ) {
      await page.waitForTimeout(delay);
      delay *= 2; // Exponential backoff
      continue;
    }

    if (!response.ok()) {
    }

    return false;
  }

  return false;
}

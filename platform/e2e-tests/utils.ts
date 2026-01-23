// biome-ignore-all lint/suspicious/noConsole: we use console.log for logging in this file
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { archestraApiSdk } from "@shared";
import { testMcpServerCommand } from "@shared/test-mcp-server";
import {
  API_BASE_URL,
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

  // Check for API errors
  if (catalogItems.error) {
    throw new Error(
      `Failed to get catalog items: ${JSON.stringify(catalogItems.error)}`,
    );
  }
  if (!catalogItems.data || catalogItems.data.length === 0) {
    throw new Error(
      `No catalog items returned from API. Response: ${JSON.stringify(catalogItems)}`,
    );
  }

  const newCatalogItem = catalogItems.data.find(
    (item) => item.name === catalogItemName,
  );
  if (!newCatalogItem) {
    const itemNames = catalogItems.data.map((i) => i.name).join(", ");
    throw new Error(
      `Failed to find catalog item "${catalogItemName}". Available items: [${itemNames}]`,
    );
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

    // Fail fast if error message is present
    const errorElement = page.getByTestId(
      `${E2eTestId.McpServerError}-${catalogItemName}`,
    );
    if (await errorElement.isVisible()) {
      const errorText = await errorElement.innerText();
      throw new Error(
        `MCP Server installation failed with error: ${errorText}`,
      );
    }

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
  const defaultAgentResponse = await archestraApiSdk.getDefaultAgent({
    headers: { Cookie: cookieHeaders },
  });
  if (defaultAgentResponse.error) {
    throw new Error(
      `Failed to get default agent: ${JSON.stringify(defaultAgentResponse.error)}`,
    );
  }
  if (!defaultAgentResponse.data) {
    throw new Error(
      `No default agent returned from API. Response: ${JSON.stringify(defaultAgentResponse)}`,
    );
  }
  const defaultProfile = defaultAgentResponse.data;

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
    await initializeMcpSession(request, {
      profileId: defaultProfile.id,
      token,
    });

    toolResult = await callMcpTool(request, {
      profileId: defaultProfile.id,
      token,
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

  // Check for API errors
  if (teamsResponse.error) {
    throw new Error(
      `Failed to get teams: ${JSON.stringify(teamsResponse.error)}`,
    );
  }
  if (!teamsResponse.data || teamsResponse.data.length === 0) {
    throw new Error(
      `No teams returned from API. Response: ${JSON.stringify(teamsResponse)}`,
    );
  }

  const defaultTeam = teamsResponse.data.find(
    (team) => team.name === DEFAULT_TEAM_NAME,
  );
  if (!defaultTeam) {
    const teamNames = teamsResponse.data.map((t) => t.name).join(", ");
    throw new Error(
      `Team "${DEFAULT_TEAM_NAME}" not found. Available teams: [${teamNames}]`,
    );
  }
  const engineeringTeam = teamsResponse.data.find(
    (team) => team.name === ENGINEERING_TEAM_NAME,
  );
  if (!engineeringTeam) {
    const teamNames = teamsResponse.data.map((t) => t.name).join(", ");
    throw new Error(
      `Team "${ENGINEERING_TEAM_NAME}" not found. Available teams: [${teamNames}]`,
    );
  }

  // 2. Get all profiles and find Default Agent
  const agentsResponse = await archestraApiSdk.getAgents({
    headers: { Cookie: cookieHeaders },
  });

  // Check for API errors
  if (agentsResponse.error) {
    throw new Error(
      `Failed to get agents: ${JSON.stringify(agentsResponse.error)}`,
    );
  }
  if (!agentsResponse.data?.data || agentsResponse.data.data.length === 0) {
    throw new Error(
      `No agents returned from API. Response: ${JSON.stringify(agentsResponse)}`,
    );
  }

  const defaultProfile = agentsResponse.data.data.find(
    (agent) => agent.name === DEFAULT_PROFILE_NAME,
  );
  if (!defaultProfile) {
    const profileNames = agentsResponse.data.data.map((a) => a.name).join(", ");
    throw new Error(
      `Profile "${DEFAULT_PROFILE_NAME}" not found. Available profiles: [${profileNames}]`,
    );
  }

  // 3. Assign BOTH Default Team and Engineering Team to the profile
  const updateResponse = await archestraApiSdk.updateAgent({
    headers: { Cookie: cookieHeaders },
    path: { id: defaultProfile.id },
    body: {
      teams: [defaultTeam.id, engineeringTeam.id],
    },
  });

  // Check for API errors on update
  if (updateResponse.error) {
    throw new Error(
      `Failed to update agent: ${JSON.stringify(updateResponse.error)}`,
    );
  }
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

/**
 * Find a catalog item by name
 */
export async function findCatalogItem(
  request: APIRequestContext,
  name: string,
): Promise<{ id: string; name: string } | undefined> {
  const response = await request.get(
    `${API_BASE_URL}/api/internal_mcp_catalog`,
    {
      headers: { Origin: UI_BASE_URL },
    },
  );

  if (!response.ok()) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch internal MCP catalog: ${response.status()} ${errorText}`,
    );
  }

  const catalog = await response.json();

  if (!Array.isArray(catalog)) {
    throw new Error(
      `Expected catalog to be an array, got: ${JSON.stringify(catalog)}`,
    );
  }

  return catalog.find((item: { name: string }) => item.name === name);
}

/**
 * Find an installed MCP server by catalog ID and optionally by team ID.
 * When teamId is provided, only returns servers installed for that specific team.
 */
export async function findInstalledServer(
  request: APIRequestContext,
  catalogId: string,
  teamId?: string,
): Promise<{ id: string; catalogId: string; teamId?: string } | undefined> {
  const response = await request.get(`${API_BASE_URL}/api/mcp_server`, {
    headers: { Origin: UI_BASE_URL },
  });
  const serversData = await response.json();
  const servers = serversData.data || serversData;
  return servers.find((s: { catalogId: string; teamId?: string }) => {
    if (s.catalogId !== catalogId) return false;
    if (teamId !== undefined && s.teamId !== teamId) return false;
    return true;
  });
}

/**
 * Wait for MCP server installation to complete.
 * Polls the server status until it becomes "success" or "error".
 * Note: Even after status becomes "success", the K8s deployment may need
 * additional time to be fully ready to handle requests, so we add a delay.
 */
export async function waitForServerInstallation(
  request: APIRequestContext,
  serverId: string,
  maxAttempts = 60,
): Promise<{
  localInstallationStatus: string;
  localInstallationError?: string;
}> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await request.get(
      `${API_BASE_URL}/api/mcp_server/${serverId}`,
      {
        headers: { Origin: UI_BASE_URL },
      },
    );
    const server = await response.json();

    if (server.localInstallationStatus === "success") {
      // Add delay to ensure K8s deployment is fully ready
      // The DB status may update before the deployment is accessible
      await new Promise((r) => setTimeout(r, 3000));
      return server;
    }
    if (server.localInstallationStatus === "error") {
      throw new Error(
        `MCP server installation failed: ${server.localInstallationError}`,
      );
    }

    // Wait 2 seconds between checks
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `MCP server installation timed out after ${maxAttempts * 2} seconds`,
  );
}

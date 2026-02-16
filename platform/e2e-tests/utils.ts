// biome-ignore-all lint/suspicious/noConsole: we use console.log for logging in this file
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { archestraApiSdk, DEFAULT_MCP_GATEWAY_NAME } from "@shared";
import { testMcpServerCommand } from "@shared/test-mcp-server";
import {
  API_BASE_URL,
  DEFAULT_TEAM_NAME,
  E2eTestId,
  ENGINEERING_TEAM_NAME,
  KC_TEST_USER,
  KEYCLOAK_EXTERNAL_URL,
  KEYCLOAK_OIDC,
  KEYCLOAK_REALM,
  MARKETING_TEAM_NAME,
  UI_BASE_URL,
} from "./consts";
import { goToPage } from "./fixtures";
import {
  callMcpTool,
  getOrgTokenForProfile,
  getTeamTokenForProfile,
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

  // After adding a server, the install dialog opens automatically.
  // Close it so the calling test can control when to open it.
  // Wait for the install dialog to appear and then close it by pressing Escape.
  await page
    .getByRole("dialog")
    .filter({ hasText: /Install -/ })
    .waitFor({ state: "visible", timeout: 10000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

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

export async function closeOpenDialogs(
  page: Page,
  options?: { timeoutMs?: number },
) {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const start = Date.now();
  const dialogs = page.getByRole("dialog");

  while (Date.now() - start < timeoutMs) {
    const count = await dialogs.count();
    let hasVisibleDialog = false;
    for (let index = 0; index < count; index += 1) {
      if (await dialogs.nth(index).isVisible()) {
        hasVisibleDialog = true;
        break;
      }
    }

    if (!hasVisibleDialog) {
      return;
    }

    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);

    const closeButton = dialogs
      .getByRole("button", { name: /close|done|cancel/i })
      .first();
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await page.waitForTimeout(250);
    }
  }

  await expect(dialogs).not.toBeVisible({ timeout: 1000 });
}

export async function goToMcpRegistryAndOpenManageToolsAndOpenTokenSelect({
  page,
  catalogItemName,
  timeoutMs,
}: {
  page: Page;
  catalogItemName: string;
  timeoutMs?: number;
}) {
  const waitTimeoutMs = timeoutMs ?? 60_000;
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
  }).toPass({ timeout: waitTimeoutMs, intervals: [3000, 5000, 7000, 10000] });

  await manageToolsButton.click();

  // Wait for dialog to open
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForLoadState("networkidle");

  // The new McpAssignmentsDialog shows profile pills - click on "Default MCP Gateway" to open popover
  const dialog = page.getByRole("dialog");
  const profilePill = dialog.getByRole("button", {
    name: new RegExp(`${DEFAULT_MCP_GATEWAY_NAME}.*\\(\\d+/\\d+\\)`),
  });

  const showMoreButton = dialog.getByRole("button", {
    name: /^\+\d+ more$/,
  });

  if (!(await profilePill.isVisible().catch(() => false))) {
    if (await showMoreButton.isVisible().catch(() => false)) {
      await showMoreButton.click();
      await page.waitForTimeout(200);
    }
  }

  await profilePill.waitFor({ state: "visible", timeout: 30_000 });
  await profilePill.click();

  // Wait for the popover to open - it contains the credential selector and tool checkboxes
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);

  // Click the first tool checkbox to select a tool
  // The checkbox is inside the popover, wait for it to be visible
  const checkbox = page.getByRole("checkbox").first();
  await checkbox.waitFor({ state: "visible", timeout: 5_000 });
  await checkbox.click();

  // The combobox (credential selector) is now in the popover
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
  const defaultMcpGatewayResponse = await archestraApiSdk.getDefaultMcpGateway({
    headers: { Cookie: cookieHeaders },
  });
  if (defaultMcpGatewayResponse.error) {
    throw new Error(
      `Failed to get default MCP gateway: ${JSON.stringify(defaultMcpGatewayResponse.error)}`,
    );
  }
  if (!defaultMcpGatewayResponse.data) {
    throw new Error(
      `No default MCP gateway returned from API. Response: ${JSON.stringify(defaultMcpGatewayResponse)}`,
    );
  }
  const defaultProfile = defaultMcpGatewayResponse.data;

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
    toolResult = await callMcpTool(request, {
      profileId: defaultProfile.id,
      token,
      toolName,
      timeoutMs: 60_000,
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

  // 2. Get the default MCP Gateway profile
  const defaultMcpGatewayResponse = await archestraApiSdk.getDefaultMcpGateway({
    headers: { Cookie: cookieHeaders },
  });

  // Check for API errors
  if (defaultMcpGatewayResponse.error) {
    throw new Error(
      `Failed to get default MCP gateway: ${JSON.stringify(defaultMcpGatewayResponse.error)}`,
    );
  }
  if (!defaultMcpGatewayResponse.data) {
    throw new Error(
      `No default MCP gateway returned from API. Response: ${JSON.stringify(defaultMcpGatewayResponse)}`,
    );
  }

  const defaultProfile = defaultMcpGatewayResponse.data;

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
 * Login via UI form (fills email/password fields and clicks submit).
 * Assumes the page is already on the sign-in page.
 *
 * @param page - Playwright page already on the sign-in page
 * @param email - User email
 * @param password - User password
 */
export async function loginViaUi(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in|login/i }).click();
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

// =============================================================================
// Keycloak SSO/Identity Provider Helpers
// =============================================================================

/**
 * Get a JWT access token from Keycloak using the resource owner password
 * credentials grant (direct access grant).
 */
export async function getKeycloakJwt(): Promise<string> {
  // Use KEYCLOAK_EXTERNAL_URL because this runs from the Playwright test container
  // (outside K8s), not from the backend. KEYCLOAK_OIDC.tokenEndpoint uses K8s internal
  // DNS which is not resolvable from the test container.
  const tokenUrl = `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: KEYCLOAK_OIDC.clientId,
      client_secret: KEYCLOAK_OIDC.clientSecret,
      username: KC_TEST_USER.username,
      password: KC_TEST_USER.password,
      scope: "openid",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Keycloak token request failed: ${response.status} ${text}`,
    );
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Perform SSO login via Keycloak in the given page context.
 * This handles the Keycloak login form and waits for redirect back to Archestra.
 * Works for both OIDC and SAML flows since Keycloak uses the same login UI.
 *
 * @param ssoPage - The Playwright page that has been redirected to Keycloak
 * @returns true if login succeeded (landed on non-sign-in page), false if it failed
 */
export async function loginViaKeycloak(ssoPage: Page): Promise<boolean> {
  // Wait for redirect to Keycloak (external URL for browser)
  // Since we're using a fresh browser context, Keycloak should always show login form
  await ssoPage.waitForURL(/.*localhost:30081.*|.*keycloak.*/, {
    timeout: 30000,
  });

  // Wait for Keycloak login form to be ready
  await ssoPage.waitForLoadState("networkidle");

  // Fill in Keycloak login form
  const usernameField = ssoPage.getByLabel("Username or email");
  await usernameField.waitFor({ state: "visible", timeout: 10000 });
  await usernameField.fill(KC_TEST_USER.username);

  // Password field - use getByRole which works for type="password" inputs
  const passwordField = ssoPage.getByRole("textbox", { name: "Password" });
  await passwordField.waitFor({ state: "visible", timeout: 10000 });
  await passwordField.fill(KC_TEST_USER.password);

  await clickButton({ page: ssoPage, options: { name: "Sign In" } });

  // Wait for redirect back to Archestra (any page under UI_BASE_URL)
  await ssoPage.waitForURL(`${UI_BASE_URL}/**`, { timeout: 60000 });

  // Wait for page to settle
  await ssoPage.waitForLoadState("networkidle");

  // Check if we landed on a logged-in page (not sign-in)
  const finalUrl = ssoPage.url();
  const loginSucceeded = !finalUrl.includes("/auth/sign-in");

  // If login failed, try to capture any error message for debugging
  if (!loginSucceeded) {
    // Check for error toast or message on the sign-in page
    const errorToast = ssoPage.locator('[role="alert"]').first();
    const errorText = await errorToast.textContent().catch(() => null);
    if (errorText && !errorText.includes("Default Admin Credentials Enabled")) {
      console.log(`SSO login failed with error: ${errorText}`);
    }
  }

  return loginSucceeded;
}

/**
 * Fetch the IdP metadata from Keycloak dynamically.
 * This is necessary because Keycloak regenerates certificates on restart,
 * so we can't use hardcoded certificates in tests.
 * Also modifies WantAuthnRequestsSigned to "false" to avoid signing complexity.
 * Uses external URL since this runs from the test (CI host), not from inside K8s.
 */
export async function fetchKeycloakSamlMetadata(): Promise<string> {
  const response = await fetch(
    `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/saml/descriptor`,
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Keycloak SAML metadata: ${response.status}`,
    );
  }
  const metadata = await response.text();
  // Modify WantAuthnRequestsSigned to "false" to avoid signing complexity in tests
  return metadata.replace(
    'WantAuthnRequestsSigned="true"',
    'WantAuthnRequestsSigned="false"',
  );
}

/**
 * Extract the X509 certificate from the IdP metadata XML.
 */
export function extractCertFromMetadata(metadata: string): string {
  const match = metadata.match(
    /<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/,
  );
  if (!match) {
    throw new Error("Could not extract certificate from IdP metadata");
  }
  return match[1];
}

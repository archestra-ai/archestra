// biome-ignore-all lint/suspicious/noConsole: we use console.log for logging in this file
import { E2eTestId } from "@shared";
import { ADMIN_EMAIL, ADMIN_PASSWORD, IS_CI, UI_BASE_URL } from "../../consts";
import { expect, type Page, test } from "../../fixtures";
import { clickButton, loginViaApi } from "../../utils";

// Run tests in this file serially to avoid conflicts when both tests
// manipulate SSO providers in the same Keycloak realm.
// Also skip webkit and firefox for these tests since they share the same backend
// and running in parallel causes SSO provider conflicts.
test.describe.configure({ mode: "serial" });

// =============================================================================
// Keycloak Configuration
// =============================================================================
// These match the values in helm/e2e-tests/values.yaml
const KEYCLOAK_EXTERNAL_URL = "http://localhost:30081";
const KEYCLOAK_BACKEND_URL = IS_CI
  ? "http://e2e-tests-keycloak:8080"
  : "http://localhost:30081";
const KEYCLOAK_REALM = "archestra";

// OIDC client configuration
const KEYCLOAK_OIDC = {
  clientId: "archestra-oidc",
  clientSecret: "archestra-oidc-secret",
  issuer: `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}`,
  discoveryEndpoint: `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration`,
  authorizationEndpoint: `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth`,
  tokenEndpoint: `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`,
  jwksEndpoint: `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
};

// SAML configuration
const KEYCLOAK_SAML = {
  entityId: `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}`,
  ssoUrl: `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/saml`,
};

// Test user credentials (match Archestra admin for account linking)
const KEYCLOAK_TEST_USER = ADMIN_EMAIL.split("@")[0];
const KEYCLOAK_TEST_PASSWORD = ADMIN_PASSWORD;

// SSO domain - extracted from admin email for account linking
const SSO_DOMAIN = ADMIN_EMAIL.split("@")[1];

// =============================================================================
// Shared Test Helpers
// =============================================================================

/**
 * Authenticate as admin via API and navigate to SSO providers page.
 * SSO tests don't use storage state to avoid session conflicts.
 * Clears existing cookies first to ensure clean authentication state.
 * Uses polling with retry to handle timing issues.
 */
async function ensureAdminAuthenticated(page: Page): Promise<void> {
  // Clear all cookies to ensure no stale session cookies interfere with login
  // This is critical on retries where previous SSO logins may have invalidated sessions
  await page.context().clearCookies();

  // Retry login up to 5 times to handle transient issues and server instability
  let loginSucceeded = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    loginSucceeded = await loginViaApi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    if (loginSucceeded) break;
    // Wait before retry
    await page.waitForTimeout(2000);
  }

  if (!loginSucceeded) {
    console.log("Admin API login failed after 5 attempts");
  }

  // Navigate directly to SSO providers page
  // The API login should have set session cookies that persist
  await page.goto(`${UI_BASE_URL}/settings/sso-providers`);
  await page.waitForLoadState("networkidle");

  // Wait briefly for any redirects to complete
  await page.waitForTimeout(1000);

  // Check if we got redirected to sign-in (authentication failed)
  if (page.url().includes("/auth/sign-in")) {
    console.log(
      "API login appeared to fail (redirected to sign-in), trying UI fallback...",
    );
    // Try logging in via UI as fallback
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Login" }).click();
    await page.waitForLoadState("networkidle");

    // Check for error toast or message on the sign-in page
    const errorToast = page.locator('[role="alert"]').first();
    if (await errorToast.isVisible()) {
      const errorText = await errorToast.textContent().catch(() => null);
      if (
        errorText &&
        !errorText.includes("Default Admin Credentials Enabled")
      ) {
        console.log(`UI Login failed with error: ${errorText}`);
      }
    }

    // Wait for login to complete and redirect away from sign-in
    try {
      await expect(page).not.toHaveURL(/\/auth\/sign-in/, { timeout: 45000 });
    } catch {
      // If still on sign-in, try a hard reload and check URL again
      // Sometimes state is stale or cookie needs a nudge
      console.log(
        "Still on sign-in after login, attempting reload to check session...",
      );
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page).not.toHaveURL(/\/auth\/sign-in/, { timeout: 15000 });
    }

    // Navigate to SSO providers after UI login
    await page.goto(`${UI_BASE_URL}/settings/sso-providers`);
    await page.waitForLoadState("networkidle");
  }

  await expect(page).toHaveURL(/\/settings\/sso-providers/, { timeout: 30000 });
  await expect(
    page.getByRole("heading", { name: "SSO Providers" }),
  ).toBeVisible({ timeout: 10000 });
}

/**
 * Fill in the standard OIDC provider form fields.
 */
async function fillOidcProviderForm(
  page: Page,
  providerName: string,
): Promise<void> {
  await page.getByLabel("Provider ID").fill(providerName);
  await page.getByLabel("Issuer").fill(KEYCLOAK_OIDC.issuer);
  await page.getByLabel("Domain").fill(SSO_DOMAIN);
  await page.getByLabel("Client ID").fill(KEYCLOAK_OIDC.clientId);
  await page.getByLabel("Client Secret").fill(KEYCLOAK_OIDC.clientSecret);
  await page
    .getByLabel("Discovery Endpoint")
    .fill(KEYCLOAK_OIDC.discoveryEndpoint);
  await page
    .getByLabel("Authorization Endpoint")
    .fill(KEYCLOAK_OIDC.authorizationEndpoint);
  await page.getByLabel("Token Endpoint").fill(KEYCLOAK_OIDC.tokenEndpoint);
  await page.getByLabel("JWKS Endpoint").fill(KEYCLOAK_OIDC.jwksEndpoint);
}

/**
 * Delete an SSO provider via the UI dialog.
 */
async function deleteProviderViaDialog(page: Page): Promise<void> {
  await clickButton({ page, options: { name: "Delete" } });
  await expect(page.getByText(/Are you sure/i)).toBeVisible();
  await clickButton({ page, options: { name: "Delete", exact: true } });
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });
}

/**
 * Fetch the IdP metadata from Keycloak dynamically.
 * This is necessary because Keycloak regenerates certificates on restart,
 * so we can't use hardcoded certificates in tests.
 * Also modifies WantAuthnRequestsSigned to "false" to avoid signing complexity.
 * Uses external URL since this runs from the test (CI host), not from inside K8s.
 */
async function fetchKeycloakSamlMetadata(): Promise<string> {
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
 * Ensure a clean slate by deleting any existing SSO provider of the given type.
 * This makes tests idempotent - they can be retried or re-run without manual cleanup.
 *
 * @param page - The Playwright page (logged in as admin, on SSO providers page)
 * @param providerType - Either "Generic OIDC" or "Generic SAML"
 */
async function deleteExistingProviderIfExists(
  page: Page,
  providerType: "Generic OIDC" | "Generic SAML",
): Promise<void> {
  // Verify we're on the SSO providers page before proceeding
  // This handles cases where previous test left page on a different route
  await expect(page).toHaveURL(/\/settings\/sso-providers/, { timeout: 10000 });

  // Wait for the SSO providers heading to be visible (page content loaded)
  await expect(
    page.getByRole("heading", { name: "SSO Providers" }),
  ).toBeVisible({ timeout: 15000 });

  const providerCard = page.getByText(providerType, { exact: true });
  // Wait for card to be visible and stable before clicking (increased timeout for CI)
  await providerCard.waitFor({ state: "visible", timeout: 20000 });
  await providerCard.click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10000 });

  // Check if this is edit or create dialog by looking for Update Provider button
  const updateButton = page.getByRole("button", { name: "Update Provider" });
  const isEditDialog = await updateButton.isVisible().catch(() => false);

  if (isEditDialog) {
    // Delete existing provider first
    await clickButton({ page, options: { name: "Delete" } });
    await expect(page.getByText(/Are you sure/i)).toBeVisible({
      timeout: 10000,
    });
    const confirmDeleteButton = page.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await confirmDeleteButton.waitFor({ state: "visible" });
    await confirmDeleteButton.click();
    await expect(page.getByRole("dialog")).not.toBeVisible({
      timeout: 10000,
    });

    // Reload and wait for page to update
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Wait for card to be visible again after reload, then click to open create dialog
    await providerCard.waitFor({ state: "visible" });
    await providerCard.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10000 });
  }
  // If not an edit dialog, it's already a create dialog - nothing to delete
}

/**
 * Perform SSO login via Keycloak in the given page context.
 * This handles the Keycloak login form and waits for redirect back to Archestra.
 * Works for both OIDC and SAML flows since Keycloak uses the same login UI.
 *
 * @param ssoPage - The Playwright page that has been redirected to Keycloak
 * @returns true if login succeeded (landed on non-sign-in page), false if it failed
 */
async function loginViaKeycloak(ssoPage: Page): Promise<boolean> {
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
  await usernameField.fill(KEYCLOAK_TEST_USER);

  // Password field - use getByRole which works for type="password" inputs
  const passwordField = ssoPage.getByRole("textbox", { name: "Password" });
  await passwordField.waitFor({ state: "visible", timeout: 10000 });
  await passwordField.fill(KEYCLOAK_TEST_PASSWORD);

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
 * Extract the X509 certificate from the IdP metadata XML.
 */
function extractCertFromMetadata(metadata: string): string {
  const match = metadata.match(
    /<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/,
  );
  if (!match) {
    throw new Error("Could not extract certificate from IdP metadata");
  }
  return match[1];
}

test.describe("SSO Team Sync E2E", () => {
  test("should sync user to team based on SSO group membership", async ({
    page,
    browser,
    goToPage,
    makeRandomString,
  }) => {
    test.slow();

    const providerName = `TeamSyncOIDC${Date.now()}`;
    const teamName = makeRandomString(8, "SyncTeam");
    const externalGroup = "archestra-admins"; // Matches Keycloak admin user's group

    // STEP 0: Clean up orphan SyncTeam teams from previous failed test runs
    // These teams can have the same external group mapping, causing SSO sync to add
    // users to the wrong team
    await ensureAdminAuthenticated(page);
    await goToPage(page, "/settings/teams");
    await page.waitForLoadState("networkidle");

    // Find and delete any existing SyncTeam-* teams
    const orphanTeams = page.locator(".rounded-lg.border.p-4").filter({
      has: page.locator('h3:text-matches("SyncTeam-.*")'),
    });
    const orphanCount = await orphanTeams.count();

    for (let i = orphanCount - 1; i >= 0; i--) {
      // Re-locate since DOM changes after each delete
      const team = page
        .locator(".rounded-lg.border.p-4")
        .filter({ has: page.locator('h3:text-matches("SyncTeam-.*")') })
        .first();
      if ((await team.count()) === 0) break;

      // Find and click the delete button (trash icon)
      await team
        .getByRole("button")
        .filter({ has: page.locator("svg") })
        .last()
        .click();
      await expect(page.getByText(/Are you sure/i)).toBeVisible({
        timeout: 5000,
      });
      await clickButton({ page, options: { name: "Delete", exact: true } });
      await expect(page.getByRole("dialog")).not.toBeVisible({
        timeout: 10000,
      });
      await page.waitForLoadState("networkidle");
    }

    // STEP 1: Authenticate and create OIDC provider
    await goToPage(page, "/settings/sso-providers");
    await page.waitForLoadState("networkidle");
    await deleteExistingProviderIfExists(page, "Generic OIDC");
    await fillOidcProviderForm(page, providerName);
    await clickButton({ page, options: { name: "Create Provider" } });
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    // STEP 2: Navigate to teams page and create a team
    // Re-authenticate in case session was invalidated during SSO provider creation
    await ensureAdminAuthenticated(page);
    await goToPage(page, "/settings/teams");
    await page.waitForLoadState("networkidle");

    // Wait for page to fully load and Create Team button to be enabled
    // The button may be disabled while permissions/data are loading
    const createTeamButton = page.getByRole("button", { name: "Create Team" });
    await expect(createTeamButton).toBeVisible({ timeout: 15000 });
    await expect(createTeamButton).toBeEnabled({ timeout: 10000 });
    await createTeamButton.click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Fill in team details
    await page.getByLabel("Team Name").fill(teamName);
    await page
      .getByLabel("Description")
      .fill("Team for testing SSO group sync");

    // Submit
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create Team" })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    // Wait for team to appear in the list
    await expect(page.getByText(teamName)).toBeVisible({ timeout: 5000 });

    // STEP 3: Link external group to the team
    // First get the team ID from the API since we need it for the testid
    const teamResponse = await page.request.get(
      `http://localhost:9000/api/teams`,
    );
    const teams = await teamResponse.json();
    const createdTeam = teams.find(
      (t: { name: string }) => t.name === teamName,
    );

    // Click the SSO Team Sync button using data-testid
    await page
      .getByTestId(`${E2eTestId.ConfigureSsoTeamSyncButton}-${createdTeam.id}`)
      .click();

    // Wait for dialog to appear
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("External Group Sync")).toBeVisible();

    // Add the external group mapping
    await page.getByPlaceholder(/archestra-admins/).fill(externalGroup);
    await clickButton({ page, options: { name: "Add" } });

    // Wait for the success toast to confirm the API call completed
    // This is critical - the group must be saved to the database before SSO login
    await expect(page.getByText("External group mapping added")).toBeVisible({
      timeout: 10000,
    });

    // Also verify the group appears in the current mappings list (not just the input)
    await expect(page.getByRole("dialog").getByText(externalGroup)).toBeVisible(
      { timeout: 5000 },
    );

    // Close the dialog - use first() to target the text button, not the X icon
    await clickButton({
      page,
      options: { name: "Close", exact: true },
      first: true,
    });
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });

    // STEP 4: Test SSO login with admin user (in archestra-admins group)
    const ssoContext = await browser.newContext({
      storageState: undefined,
    });
    const ssoPage = await ssoContext.newPage();

    try {
      await ssoPage.goto(`${UI_BASE_URL}/auth/sign-in`);
      await ssoPage.waitForLoadState("networkidle");

      // Wait for SSO button to appear (provider was just created)
      const ssoButton = ssoPage.getByRole("button", {
        name: new RegExp(providerName, "i"),
      });
      await expect(ssoButton).toBeVisible({ timeout: 10000 });

      // Click SSO button and login via Keycloak
      await clickButton({
        page: ssoPage,
        options: { name: new RegExp(providerName, "i") },
      });

      // Login via Keycloak (admin user is in archestra-admins group)
      const loginSucceeded = await loginViaKeycloak(ssoPage);
      expect(loginSucceeded).toBe(true);

      // Verify we're logged in
      await expect(ssoPage.locator("text=Tool Policies").first()).toBeVisible({
        timeout: 15000,
      });

      // STEP 5: Verify user was automatically added to the team
      // Team sync is an async background operation during SSO callback
      // Give it a moment to complete before navigating
      await ssoPage.waitForTimeout(2000);

      // Navigate to teams page
      await ssoPage.goto(`${UI_BASE_URL}/settings/teams`);
      await ssoPage.waitForLoadState("networkidle");

      // Find the team row helper
      const getTeamRow = () =>
        ssoPage.locator(".rounded-lg.border.p-4").filter({ hasText: teamName });

      // Poll until the team card shows at least 1 member
      await expect(async () => {
        // Force a fresh page load by navigating away and back
        await ssoPage.goto(`${UI_BASE_URL}/`);
        await ssoPage.waitForLoadState("networkidle");
        await ssoPage.goto(`${UI_BASE_URL}/settings/teams`);
        await ssoPage.waitForLoadState("networkidle");

        const teamRow = getTeamRow();
        await expect(teamRow).toBeVisible({ timeout: 5000 });

        // Get the member count text
        const memberText = await teamRow
          .locator("text=/\\d+ member/")
          .textContent();
        // Team should have at least 1 member after sync
        if (memberText === "0 members") {
          throw new Error(`Team still shows 0 members, got: ${memberText}`);
        }
      }).toPass({ timeout: 60_000, intervals: [3000, 5000, 7000, 10000] });

      // Verify the SSO user is in the team members list by opening the dialog
      // Open manage members dialog
      const teamRow = getTeamRow();
      const manageButton = teamRow.getByTestId(
        `${E2eTestId.ManageMembersButton}-${teamName}`,
      );
      await manageButton.click();
      await ssoPage.getByRole("dialog").waitFor({ state: "visible" });

      // The email should now be visible since the member was synced
      const emailLocator = ssoPage
        .getByRole("dialog")
        .getByText(new RegExp(ADMIN_EMAIL, "i"));
      await expect(emailLocator).toBeVisible({ timeout: 10000 });

      // Success! The SSO user was automatically synced to the team
    } finally {
      await ssoContext.close();
    }

    // STEP 6: Cleanup
    // Delete the team
    await goToPage(page, "/settings/teams");
    await page.waitForLoadState("networkidle");

    // Find the team card by name and click the delete button
    const teamCard = page
      .locator(".rounded-lg.border.p-4")
      .filter({ hasText: teamName });
    await expect(teamCard).toBeVisible({ timeout: 5000 });
    // The delete button has a Trash icon - find it within the team card
    await teamCard
      .getByRole("button")
      .filter({ has: page.locator("svg") })
      .last()
      .click();

    await expect(page.getByText(/Are you sure/i)).toBeVisible();
    await clickButton({ page, options: { name: "Delete", exact: true } });
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    // Delete the SSO provider
    await goToPage(page, "/settings/sso-providers");
    await page.waitForLoadState("networkidle");
    await page.getByText("Generic OIDC", { exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await deleteProviderViaDialog(page);
  });
});

test.describe("SSO OIDC E2E Flow with Keycloak", () => {
  test("should configure OIDC provider, login via SSO, update, and delete", async ({
    page,
    browser,
    goToPage,
  }) => {
    test.slow();
    const providerName = `KeycloakOIDC${Date.now()}`;

    // STEP 1: Authenticate and clean up any existing provider
    await ensureAdminAuthenticated(page);
    await deleteExistingProviderIfExists(page, "Generic OIDC");

    // STEP 2: Fill in OIDC provider form and submit
    await fillOidcProviderForm(page, providerName);
    await clickButton({ page, options: { name: "Create Provider" } });

    // Wait for dialog to close and provider to be created
    await expect(page.getByRole("dialog")).not.toBeVisible({
      timeout: 10000,
    });

    // Verify the provider is now shown as "Enabled"
    await page.reload();
    await page.waitForLoadState("networkidle");

    // STEP 3: Verify SSO button appears on login page and test SSO login
    // Use a fresh browser context (not logged in) to test the SSO flow
    const ssoContext = await browser.newContext({
      storageState: undefined,
    });
    const ssoPage = await ssoContext.newPage();

    try {
      await ssoPage.goto(`${UI_BASE_URL}/auth/sign-in`);
      await ssoPage.waitForLoadState("networkidle");

      // Verify SSO button for our provider appears
      await expect(
        ssoPage.getByRole("button", { name: new RegExp(providerName, "i") }),
      ).toBeVisible({ timeout: 5000 });

      // STEP 4: Click SSO button and login via Keycloak
      await clickButton({
        page: ssoPage,
        options: { name: new RegExp(providerName, "i") },
      });

      // Login via Keycloak and wait for redirect back to Archestra
      const loginSucceeded = await loginViaKeycloak(ssoPage);
      expect(loginSucceeded).toBe(true);

      // Verify we're logged in by checking for authenticated UI elements
      // Use text locator as fallback since getByRole can be flaky with complex UIs
      await expect(ssoPage.locator("text=Tool Policies").first()).toBeVisible({
        timeout: 15000,
      });

      // SSO login successful - user is now logged in
    } finally {
      await ssoContext.close();
    }

    // STEP 5: Use the original admin page context to update the provider
    // (the original page context is still logged in as admin)
    await goToPage(page, "/settings/sso-providers");
    await page.waitForLoadState("networkidle");

    // Click on Generic OIDC card to edit (our provider)
    await page.getByText("Generic OIDC", { exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Update the domain (use a subdomain to keep it valid for the same email domain)
    await page.getByLabel("Domain").clear();
    await page.getByLabel("Domain").fill(`updated.${SSO_DOMAIN}`);

    // Save changes
    await clickButton({ page, options: { name: "Update Provider" } });
    await expect(page.getByRole("dialog")).not.toBeVisible({
      timeout: 10000,
    });

    // STEP 6: Delete the provider
    await page.getByText("Generic OIDC", { exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await deleteProviderViaDialog(page);

    // STEP 7: Verify SSO button no longer appears on login page
    // Use a fresh context to check the sign-in page
    const verifyContext = await browser.newContext({
      storageState: undefined,
    });
    const verifyPage = await verifyContext.newPage();

    try {
      await verifyPage.goto(`${UI_BASE_URL}/auth/sign-in`);
      await verifyPage.waitForLoadState("networkidle");

      // SSO button for our provider should no longer be visible
      await expect(
        verifyPage.getByRole("button", {
          name: new RegExp(providerName, "i"),
        }),
      ).not.toBeVisible({ timeout: 5000 });
    } finally {
      await verifyContext.close();
    }
  });
});

test.describe("SSO Role Mapping E2E", () => {
  test("should map admin group to admin role via OIDC", async ({
    page,
    browser,
    goToPage,
  }) => {
    test.slow();
    const providerName = `RoleMappingOIDC${Date.now()}`;

    // STEP 1: Authenticate and clean up any existing provider
    await ensureAdminAuthenticated(page);
    await deleteExistingProviderIfExists(page, "Generic OIDC");

    // STEP 2: Fill in OIDC provider form
    await fillOidcProviderForm(page, providerName);

    // STEP 2: Configure Role Mapping
    // Expand the Role Mapping accordion
    await page.getByText("Role Mapping (Optional)").click();

    // Wait for accordion to expand - look for the Add Rule button
    const addRuleButton = page.getByTestId(E2eTestId.SsoRoleMappingAddRule);
    await expect(addRuleButton).toBeVisible();

    // Add a rule to map archestra-admins group to admin role
    await addRuleButton.click();

    // Fill in the Handlebars template using data-testid
    // Keycloak sends groups as an array, so we check if 'archestra-admins' is in it
    await page
      .getByTestId(E2eTestId.SsoRoleMappingRuleTemplate)
      .fill('{{#includes groups "archestra-admins"}}true{{/includes}}');

    // Select admin role using data-testid
    const roleSelect = page.getByTestId(E2eTestId.SsoRoleMappingRuleRole);
    await roleSelect.click();
    await page.getByRole("option", { name: "Admin" }).click();

    // Set default role to member (so we can verify role mapping works)
    const defaultRoleSelect = page.getByTestId(
      E2eTestId.SsoRoleMappingDefaultRole,
    );
    if (await defaultRoleSelect.isVisible()) {
      await defaultRoleSelect.click();
      await page.getByRole("option", { name: "Member" }).click();
    }

    // Submit the form
    await clickButton({ page, options: { name: "Create Provider" } });
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    // STEP 3: Test SSO login with admin user (in archestra-admins group)
    // The admin user is configured in Keycloak with the archestra-admins group
    const ssoContext = await browser.newContext({
      storageState: undefined,
    });
    const ssoPage = await ssoContext.newPage();

    try {
      await ssoPage.goto(`${UI_BASE_URL}/auth/sign-in`);
      await ssoPage.waitForLoadState("networkidle");

      // Wait for SSO button to appear (provider was just created)
      const ssoButton = ssoPage.getByRole("button", {
        name: new RegExp(providerName, "i"),
      });
      await expect(ssoButton).toBeVisible({ timeout: 10000 });

      // Click SSO button and login via Keycloak
      await clickButton({
        page: ssoPage,
        options: { name: new RegExp(providerName, "i") },
      });

      // Login via Keycloak (admin user is in archestra-admins group)
      const loginSucceeded = await loginViaKeycloak(ssoPage);
      expect(loginSucceeded).toBe(true);

      // Verify we're logged in
      await expect(ssoPage.locator("text=Tool Policies").first()).toBeVisible({
        timeout: 15000,
      });

      // Verify the user has admin role by checking they can access admin-only pages
      // The Roles settings page is only accessible to admins
      await ssoPage.goto(`${UI_BASE_URL}/settings/roles`);
      await ssoPage.waitForLoadState("networkidle");

      // If user has admin role, they should see the Roles page
      // If not, they would be redirected or see an error
      await expect(
        ssoPage.getByText("Roles", { exact: true }).first(),
      ).toBeVisible({ timeout: 10000 });

      // Success! The admin user was mapped to admin role via Handlebars template
      // Note: The syncSsoRole function (for subsequent logins) is covered by unit tests
    } finally {
      await ssoContext.close();
    }

    // STEP 4: Cleanup - delete the provider
    await goToPage(page, "/settings/sso-providers");
    await page.waitForLoadState("networkidle");
    await page.getByText("Generic OIDC", { exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await deleteProviderViaDialog(page);
  });
});

test.describe("SSO SAML E2E Flow with Keycloak", () => {
  test("should configure SAML provider, login via SSO, update, and delete", async ({
    page,
    browser,
    goToPage,
  }) => {
    test.slow();

    // Fetch IdP metadata dynamically (Keycloak regenerates certs on restart)
    const idpMetadata = await fetchKeycloakSamlMetadata();
    const idpCert = extractCertFromMetadata(idpMetadata);
    const providerName = `KeycloakSAML${Date.now()}`;

    // STEP 1: Authenticate and clean up any existing provider
    await ensureAdminAuthenticated(page);
    await deleteExistingProviderIfExists(page, "Generic SAML");

    // STEP 2: Fill in SAML provider form
    await page.getByLabel("Provider ID").fill(providerName);
    await page
      .getByLabel("Issuer", { exact: true })
      .fill(KEYCLOAK_SAML.entityId);
    await page.getByLabel("Domain").fill(SSO_DOMAIN);
    await page
      .getByLabel("SAML Issuer / Entity ID")
      .fill(KEYCLOAK_SAML.entityId);
    await page.getByLabel("SSO Entry Point URL").fill(KEYCLOAK_SAML.ssoUrl);
    await page.getByLabel("IdP Certificate").fill(idpCert);

    // IdP Metadata XML is required to avoid ERR_IDP_METADATA_MISSING_SINGLE_SIGN_ON_SERVICE error
    // The field is nested as samlConfig.idpMetadata.metadata in the schema
    await page.getByLabel("IdP Metadata XML (Recommended)").fill(idpMetadata);

    await page
      .getByLabel("Callback URL (ACS URL)")
      .fill(`http://localhost:3000/api/auth/sso/saml2/sp/acs/${providerName}`);
    // Audience should match what Keycloak sends in the SAML assertion
    await page.getByLabel("Audience (Optional)").fill("http://localhost:3000");
    // SP Entity ID is required for Better Auth to generate proper SP metadata
    // See: https://github.com/better-auth/better-auth/issues/4833
    await page.getByLabel("SP Entity ID").fill("http://localhost:3000");

    // IMPORTANT: Due to a bug in Better Auth's SSO plugin (saml.SPMetadata is not a function),
    // we must provide full SP metadata XML to bypass the broken auto-generation.
    // See: https://github.com/better-auth/better-auth/issues/4833
    // NOTE: AuthnRequestsSigned must match the IdP's WantAuthnRequestsSigned setting
    // For testing purposes, we set both to false to avoid signing complexity
    const spMetadataXml = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="http://localhost:3000">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="http://localhost:3000/api/auth/sso/saml2/sp/acs/${providerName}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
    await page.getByLabel("SP Metadata XML (Optional)").fill(spMetadataXml);

    // Configure attribute mapping to match Keycloak's SAML attribute names
    // These match the simple attribute names configured in helm/e2e-tests/values.yaml
    // Keycloak sends: email, firstName, lastName, name
    await page.getByLabel("Email Attribute").fill("email");
    await page.getByLabel("Display Name Attribute").fill("name");
    await page.getByLabel("First Name Attribute (Optional)").fill("firstName");
    await page.getByLabel("Last Name Attribute (Optional)").fill("lastName");

    // Submit the form
    await clickButton({ page, options: { name: "Create Provider" } });

    // Wait for dialog to close and provider to be created
    // Also wait for network to be idle to ensure the provider is fully created
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });
    await page.waitForLoadState("networkidle");

    // Verify the provider is now shown as "Enabled"
    await page.reload();
    await page.waitForLoadState("networkidle");

    // STEP 3: Verify SSO button appears on login page and test SSO login
    // NOTE: SAML account linking works because the backend automatically sets
    // `domainVerified: true` for SAML providers as a workaround for:
    // https://github.com/better-auth/better-auth/issues/6481
    const ssoContext = await browser.newContext({
      storageState: undefined,
    });
    const ssoPage = await ssoContext.newPage();

    try {
      await ssoPage.goto(`${UI_BASE_URL}/auth/sign-in`);
      await ssoPage.waitForLoadState("networkidle");

      // Verify SSO button for our provider appears
      const ssoButton = ssoPage.getByRole("button", {
        name: new RegExp(providerName, "i"),
      });
      await expect(ssoButton).toBeVisible({ timeout: 10000 });

      // STEP 4: Click SSO button and login via Keycloak SAML
      await clickButton({
        page: ssoPage,
        options: { name: new RegExp(providerName, "i") },
      });

      // Login via Keycloak and wait for redirect back to Archestra
      // SAML flows can be slower due to XML processing, so we increased timeout in loginViaKeycloak
      const loginSucceeded = await loginViaKeycloak(ssoPage);
      expect(loginSucceeded).toBe(true);

      // Verify we're logged in by checking for authenticated UI elements
      // Use text locator as fallback since getByRole can be flaky with complex UIs
      await expect(ssoPage.locator("text=Tool Policies").first()).toBeVisible({
        timeout: 15000,
      });

      // SSO login successful - user is now logged in
    } finally {
      await ssoContext.close();
    }

    // STEP 5: Use the original admin page context to update the provider
    // (the original page context is still logged in as admin)
    await goToPage(page, "/settings/sso-providers");
    await page.waitForLoadState("networkidle");

    // Click on Generic SAML card to edit (our provider)
    const samlCard = page.getByText("Generic SAML", { exact: true });
    await samlCard.waitFor({ state: "visible" });
    await samlCard.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10000 });

    // Update the domain (use a subdomain to keep it valid for the same email domain)
    await page.getByLabel("Domain").clear();
    await page.getByLabel("Domain").fill(`updated.${SSO_DOMAIN}`);

    // Save changes
    await clickButton({ page, options: { name: "Update Provider" } });
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });
    await page.waitForLoadState("networkidle");

    // STEP 6: Delete the provider
    const samlCardForDelete = page.getByText("Generic SAML", { exact: true });
    await samlCardForDelete.waitFor({ state: "visible" });
    await samlCardForDelete.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10000 });
    await deleteProviderViaDialog(page);
    await page.waitForLoadState("networkidle");

    // STEP 7: Verify SSO button no longer appears on login page
    // Use a fresh context to check the sign-in page
    const verifyContext = await browser.newContext({
      storageState: undefined,
    });
    const verifyPage = await verifyContext.newPage();

    try {
      await verifyPage.goto(`${UI_BASE_URL}/auth/sign-in`);
      await verifyPage.waitForLoadState("networkidle");

      // SSO button for our provider should no longer be visible
      await expect(
        verifyPage.getByRole("button", { name: new RegExp(providerName, "i") }),
      ).not.toBeVisible({ timeout: 10000 });
    } finally {
      await verifyContext.close();
    }
  });
});

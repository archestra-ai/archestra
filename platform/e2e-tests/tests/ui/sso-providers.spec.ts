import { E2eTestId } from "@shared";
import { ADMIN_EMAIL, ADMIN_PASSWORD, UI_BASE_URL } from "../../consts";
import { expect, type Page, test } from "../../fixtures";

// Run tests in this file serially to avoid conflicts when both tests
// manipulate SSO providers in the same Keycloak realm.
// Also skip webkit and firefox for these tests since they share the same backend
// and running in parallel causes SSO provider conflicts.
test.describe.configure({ mode: "serial" });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "SSO tests only run on chromium to avoid cross-browser conflicts with shared backend state",
);

// Keycloak configuration for e2e tests
// These match the values in helm/e2e-tests/values.yaml
// KEYCLOAK_EXTERNAL_URL is used for browser redirects (accessible from host machine)
// KEYCLOAK_BACKEND_URL is what the backend uses to reach Keycloak:
//   - In CI: backend runs in K8s, so it uses the internal K8s service name
//   - In local dev: backend runs on host, so it uses localhost:30081
const KEYCLOAK_EXTERNAL_URL = "http://localhost:30081";
// Detect if we're running in CI (backend is in K8s) or local dev (backend is on host)
// In CI, the ARCHESTRA_AUTH_ADMIN_EMAIL env var is set via GitHub Actions secrets
const IS_CI = process.env.CI === "true";
const KEYCLOAK_BACKEND_URL = IS_CI
  ? "http://e2e-tests-keycloak:8080"
  : "http://localhost:30081";
const KEYCLOAK_REALM = "archestra";
const KEYCLOAK_OIDC_CLIENT_ID = "archestra-oidc";
const KEYCLOAK_OIDC_CLIENT_SECRET = "archestra-oidc-secret";
const KEYCLOAK_SAML_ENTITY_ID = `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}`;
const KEYCLOAK_SAML_SSO_URL = `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/saml`;

// Keycloak test user credentials - match the Archestra admin user so SSO can link accounts.
// Test users are defined in helm/e2e-tests/values.yaml:
//   - admin@example.com (archestra-admins group) - for admin role mapping
//   - member@example.com (archestra-users group) - for member role mapping
// Extract username from email (e.g., "admin@example.com" -> "admin")
const KEYCLOAK_TEST_USER = ADMIN_EMAIL.split("@")[0];
const KEYCLOAK_TEST_PASSWORD = ADMIN_PASSWORD;

// SSO Domain - extracted from admin email for account linking to work.
// Better Auth's SSO plugin requires the provider's domain to match the user's email domain
// for non-trusted providers to enable account linking.
// e.g., "joey@archestra.ai" -> "archestra.ai"
const SSO_DOMAIN = ADMIN_EMAIL.split("@")[1];

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
  const providerCard = page.getByText(providerType, { exact: true });
  await providerCard.click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Check if this is edit or create dialog by looking for Update Provider button
  const updateButton = page.getByRole("button", { name: "Update Provider" });
  const isEditDialog = await updateButton.isVisible().catch(() => false);

  if (isEditDialog) {
    // Delete existing provider first
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(/Are you sure/i)).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({
      timeout: 10000,
    });

    // Reload and wait for page to update
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Now click again to open create dialog
    await providerCard.click();
    await expect(page.getByRole("dialog")).toBeVisible();
  }
  // If not an edit dialog, it's already a create dialog - nothing to delete
}

/**
 * Perform SSO login via Keycloak in the given page context.
 * This handles the Keycloak login form and waits for redirect back to Archestra.
 * Works for both OIDC and SAML flows since Keycloak uses the same login UI.
 *
 * @param ssoPage - The Playwright page that has been redirected to Keycloak
 */
async function loginViaKeycloak(ssoPage: Page): Promise<void> {
  // Wait for redirect to Keycloak (external URL for browser)
  await ssoPage.waitForURL(/.*localhost:30081.*|.*keycloak.*/, {
    timeout: 15000,
  });

  // Fill in Keycloak login form
  await ssoPage.getByLabel("Username or email").fill(KEYCLOAK_TEST_USER);
  // Password field - use getByRole which works for type="password" inputs
  await ssoPage
    .getByRole("textbox", { name: "Password" })
    .fill(KEYCLOAK_TEST_PASSWORD);
  await ssoPage.getByRole("button", { name: "Sign In" }).click();

  // Wait for redirect back to Archestra - should land on a logged-in page (not sign-in)
  await ssoPage.waitForURL(`${UI_BASE_URL}/**`, { timeout: 15000 });
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

test.describe(
  "SSO OIDC E2E Flow with Keycloak",
  { tag: ["@firefox", "@webkit"] },
  () => {
    test("should configure OIDC provider, login via SSO, update, and delete", async ({
      page,
      browser,
      goToPage,
    }) => {
      // OIDC flow involves multiple redirects, so triple the timeout
      test.slow();

      // Use a unique provider name to avoid conflicts with existing providers
      const providerName = `KeycloakOIDC${Date.now()}`;

      // STEP 1: Navigate to SSO providers page
      await goToPage(page, "/settings/sso-providers");
      await page.waitForLoadState("networkidle");

      // STEP 2: Delete any existing Generic OIDC provider (ensures idempotency)
      // This opens the dialog - either create (if none exists) or edit (if one exists)
      // If edit, it deletes the provider and reopens as create dialog
      await deleteExistingProviderIfExists(page, "Generic OIDC");

      // Now we should have a create dialog
      // Fill in Keycloak OIDC configuration
      // IMPORTANT: Issuer must match the token's "iss" claim, which Keycloak sets based on
      // the URL the user accessed. Since browser goes to external URL, issuer is external.
      // But backend endpoints must use internal URL (reachable from within K8s).
      await page.getByLabel("Provider ID").fill(providerName);
      // Issuer must match token's "iss" claim (external URL since browser accesses that)
      await page
        .getByLabel("Issuer")
        .fill(`${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}`);
      // Domain must match the admin user's email domain for account linking to work
      // Better Auth requires domain matching for non-trusted SSO providers
      await page.getByLabel("Domain").fill(SSO_DOMAIN);
      await page.getByLabel("Client ID").fill(KEYCLOAK_OIDC_CLIENT_ID);
      await page.getByLabel("Client Secret").fill(KEYCLOAK_OIDC_CLIENT_SECRET);
      // Discovery endpoint - backend fetches this
      await page
        .getByLabel("Discovery Endpoint")
        .fill(
          `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration`,
        );
      // Authorization endpoint - browser redirects here (always external URL)
      await page
        .getByLabel("Authorization Endpoint")
        .fill(
          `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth`,
        );
      // Token endpoint - backend calls this
      await page
        .getByLabel("Token Endpoint")
        .fill(
          `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`,
        );
      // JWKS endpoint - backend validates tokens
      await page
        .getByLabel("JWKS Endpoint")
        .fill(
          `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
        );

      // Submit the form
      await page.getByRole("button", { name: "Create Provider" }).click();

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
        await ssoPage
          .getByRole("button", { name: new RegExp(providerName, "i") })
          .click();

        // Login via Keycloak and wait for redirect back to Archestra
        await loginViaKeycloak(ssoPage);

        // Verify we're logged in by checking for authenticated UI elements
        // The sidebar navigation only appears when logged in
        await ssoPage.waitForLoadState("networkidle");
        // Use text locator as fallback since getByRole can be flaky with complex UIs
        await expect(ssoPage.locator("text=Tools").first()).toBeVisible({
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
      await page.getByRole("button", { name: "Update Provider" }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible({
        timeout: 10000,
      });

      // STEP 6: Delete the provider
      await page.getByText("Generic OIDC", { exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();

      // Click delete button
      await page.getByRole("button", { name: "Delete" }).click();

      // Confirm deletion in the confirmation dialog
      await expect(page.getByText(/Are you sure/i)).toBeVisible();
      await page.getByRole("button", { name: "Delete", exact: true }).click();

      // Wait for dialog to close
      await expect(page.getByRole("dialog")).not.toBeVisible({
        timeout: 10000,
      });

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
  },
);

test.describe("SSO Role Mapping E2E", () => {
  test("should map admin group to admin role via OIDC", async ({
    page,
    browser,
    goToPage,
  }) => {
    // Role mapping involves SSO flow, so triple the timeout
    test.slow();

    // Use a unique provider name to avoid conflicts
    const providerName = `RoleMappingOIDC${Date.now()}`;

    // STEP 1: Navigate to SSO providers page and create OIDC provider with role mapping
    await goToPage(page, "/settings/sso-providers");
    await page.waitForLoadState("networkidle");

    // Delete any existing Generic OIDC provider first
    await deleteExistingProviderIfExists(page, "Generic OIDC");

    // Fill in Keycloak OIDC configuration
    await page.getByLabel("Provider ID").fill(providerName);
    await page
      .getByLabel("Issuer")
      .fill(`${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}`);
    await page.getByLabel("Domain").fill(SSO_DOMAIN);
    await page.getByLabel("Client ID").fill(KEYCLOAK_OIDC_CLIENT_ID);
    await page.getByLabel("Client Secret").fill(KEYCLOAK_OIDC_CLIENT_SECRET);
    await page
      .getByLabel("Discovery Endpoint")
      .fill(
        `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration`,
      );
    await page
      .getByLabel("Authorization Endpoint")
      .fill(
        `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth`,
      );
    await page
      .getByLabel("Token Endpoint")
      .fill(
        `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`,
      );
    await page
      .getByLabel("JWKS Endpoint")
      .fill(
        `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
      );

    // STEP 2: Configure Role Mapping
    // Expand the Role Mapping accordion
    await page.getByText("Role Mapping (Optional)").click();

    // Wait for accordion to expand
    await expect(page.getByLabel("Data Source")).toBeVisible();

    // Add a rule to map archestra-admins group to admin role
    await page.getByRole("button", { name: "Add Rule" }).click();

    // Fill in the JMESPath expression
    // Keycloak sends groups as an array, so we check if 'archestra-admins' is in it
    await page
      .getByLabel("JMESPath Expression")
      .fill("contains(groups || `[]`, 'archestra-admins')");

    // Select admin role
    await page
      .locator('[data-testid="role-mapping-rules"]')
      .isVisible()
      .catch(() => {});
    // The role selector is the second Select in the rule form
    const roleSelect = page
      .locator('button[role="combobox"]')
      .filter({ hasText: /member|admin/i })
      .last();
    await roleSelect.click();
    await page.getByRole("option", { name: "Admin" }).click();

    // Set default role to member
    // Find the default role select (has "Default Role" label before it)
    const defaultRoleSelect = page
      .getByLabel("Default Role")
      .locator("..")
      .locator('button[role="combobox"]');
    if (await defaultRoleSelect.isVisible()) {
      await defaultRoleSelect.click();
      await page.getByRole("option", { name: "Member" }).click();
    }

    // Submit the form
    await page.getByRole("button", { name: "Create Provider" }).click();
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

      // Click SSO button and login via Keycloak
      await ssoPage
        .getByRole("button", { name: new RegExp(providerName, "i") })
        .click();

      // Login via Keycloak (admin user is in archestra-admins group)
      await loginViaKeycloak(ssoPage);

      // Wait for redirect back to Archestra
      await ssoPage.waitForLoadState("networkidle");

      // Verify we're logged in
      await expect(ssoPage.locator("text=Tools").first()).toBeVisible({
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

      // Success! The admin user was mapped to admin role via JMESPath
    } finally {
      await ssoContext.close();
    }

    // STEP 4: Cleanup - delete the provider
    await goToPage(page, "/settings/sso-providers");
    await page.waitForLoadState("networkidle");

    await page.getByText("Generic OIDC", { exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(/Are you sure/i)).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });
  });
});

test.describe("SSO Team Sync E2E", () => {
  test("should sync user to team based on SSO group membership", async ({
    page,
    browser,
    goToPage,
    makeRandomString,
  }) => {
    // Team sync involves SSO flow + team operations, so triple the timeout
    test.slow();

    // Use unique names to avoid conflicts
    const providerName = `TeamSyncOIDC${Date.now()}`;
    const teamName = makeRandomString(8, "SyncTeam");
    // This group matches the Keycloak admin user's group in values.yaml
    const externalGroup = "archestra-admins";

    // STEP 1: Navigate to SSO providers page and create OIDC provider
    await goToPage(page, "/settings/sso-providers");
    await page.waitForLoadState("networkidle");

    // Delete any existing Generic OIDC provider first
    await deleteExistingProviderIfExists(page, "Generic OIDC");

    // Fill in Keycloak OIDC configuration
    await page.getByLabel("Provider ID").fill(providerName);
    await page
      .getByLabel("Issuer")
      .fill(`${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}`);
    await page.getByLabel("Domain").fill(SSO_DOMAIN);
    await page.getByLabel("Client ID").fill(KEYCLOAK_OIDC_CLIENT_ID);
    await page.getByLabel("Client Secret").fill(KEYCLOAK_OIDC_CLIENT_SECRET);
    await page
      .getByLabel("Discovery Endpoint")
      .fill(
        `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration`,
      );
    await page
      .getByLabel("Authorization Endpoint")
      .fill(
        `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth`,
      );
    await page
      .getByLabel("Token Endpoint")
      .fill(
        `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`,
      );
    await page
      .getByLabel("JWKS Endpoint")
      .fill(
        `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
      );

    // Submit the form
    await page.getByRole("button", { name: "Create Provider" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    // STEP 2: Navigate to teams page and create a team
    await goToPage(page, "/settings/teams");
    await page.waitForLoadState("networkidle");

    // Click Create Team button
    await page.getByRole("button", { name: "Create Team" }).click();
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
    await page.getByRole("button", { name: "Add" }).click();

    // Wait for the group to be added
    await expect(page.getByRole("dialog").getByText(externalGroup)).toBeVisible(
      { timeout: 5000 },
    );

    // Close the dialog - use first() to target the text button, not the X icon
    await page
      .getByRole("button", { name: "Close", exact: true })
      .first()
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });

    // STEP 4: Test SSO login with admin user (in archestra-admins group)
    const ssoContext = await browser.newContext({
      storageState: undefined,
    });
    const ssoPage = await ssoContext.newPage();

    try {
      await ssoPage.goto(`${UI_BASE_URL}/auth/sign-in`);
      await ssoPage.waitForLoadState("networkidle");

      // Click SSO button and login via Keycloak
      await ssoPage
        .getByRole("button", { name: new RegExp(providerName, "i") })
        .click();

      // Login via Keycloak (admin user is in archestra-admins group)
      await loginViaKeycloak(ssoPage);

      // Wait for redirect back to Archestra
      await ssoPage.waitForLoadState("networkidle");

      // Verify we're logged in
      await expect(ssoPage.locator("text=Tools").first()).toBeVisible({
        timeout: 15000,
      });

      // STEP 5: Verify user was automatically added to the team
      // Team sync is async, so poll for member count change
      await ssoPage.goto(`${UI_BASE_URL}/settings/teams`);
      await ssoPage.waitForLoadState("networkidle");

      // Poll for team member count to increase (max 15 seconds)
      const teamMemberLocator = ssoPage
        .locator(".rounded-lg.border.p-4")
        .filter({ hasText: teamName })
        .locator("text=/\\d+ member/");

      await expect(async () => {
        await ssoPage.reload();
        const memberText = await teamMemberLocator.textContent();
        // Team should have at least 1 member after sync
        expect(memberText).not.toBe("0 members");
      }).toPass({ timeout: 15000, intervals: [1000, 2000, 3000] });

      // Click "Manage Members" to verify the specific user
      const syncedTeamRow = ssoPage
        .locator(".rounded-lg.border.p-4")
        .filter({ hasText: teamName });

      await syncedTeamRow
        .getByRole("button", { name: "Manage Members" })
        .click();

      await expect(ssoPage.getByRole("dialog")).toBeVisible();

      // Verify the SSO user is in the team members list
      // Note: Use ADMIN_EMAIL which matches the Keycloak user we logged in with
      await expect(
        ssoPage.getByRole("dialog").getByText(new RegExp(ADMIN_EMAIL, "i")),
      ).toBeVisible({ timeout: 5000 });

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
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    // Delete the SSO provider
    await goToPage(page, "/settings/sso-providers");
    await page.waitForLoadState("networkidle");

    await page.getByText("Generic OIDC", { exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(/Are you sure/i)).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });
  });
});

test.describe("SSO SAML E2E Flow with Keycloak", () => {
  test("should configure SAML provider, login via SSO, update, and delete", async ({
    page,
    browser,
    goToPage,
  }) => {
    // SAML flow involves more redirects and complex XML processing, so triple the timeout
    test.slow();

    // Fetch the IdP metadata dynamically from Keycloak
    // This is necessary because Keycloak regenerates certificates on restart
    const idpMetadata = await fetchKeycloakSamlMetadata();
    const idpCert = extractCertFromMetadata(idpMetadata);

    // Use a unique provider name to avoid conflicts with existing providers
    const providerName = `KeycloakSAML${Date.now()}`;

    // STEP 1: Navigate to SSO providers page
    await goToPage(page, "/settings/sso-providers");
    await page.waitForLoadState("networkidle");

    // STEP 2: Delete any existing Generic SAML provider (ensures idempotency)
    // This opens the dialog - either create (if none exists) or edit (if one exists)
    // If edit, it deletes the provider and reopens as create dialog
    await deleteExistingProviderIfExists(page, "Generic SAML");

    // Now we should have a create dialog
    // Fill in Keycloak SAML configuration
    await page.getByLabel("Provider ID").fill(providerName);
    await page
      .getByLabel("Issuer", { exact: true })
      .fill(KEYCLOAK_SAML_ENTITY_ID);
    // Domain must match the admin user's email domain for account linking to work
    // Better Auth requires domain matching for non-trusted SSO providers
    await page.getByLabel("Domain").fill(SSO_DOMAIN);
    await page
      .getByLabel("SAML Issuer / Entity ID")
      .fill(KEYCLOAK_SAML_ENTITY_ID);
    await page.getByLabel("SSO Entry Point URL").fill(KEYCLOAK_SAML_SSO_URL);
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
    await page.getByRole("button", { name: "Create Provider" }).click();

    // Wait for dialog to close and provider to be created
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

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
      await expect(
        ssoPage.getByRole("button", { name: new RegExp(providerName, "i") }),
      ).toBeVisible({ timeout: 5000 });

      // STEP 4: Click SSO button and login via Keycloak SAML
      await ssoPage
        .getByRole("button", { name: new RegExp(providerName, "i") })
        .click();

      // Login via Keycloak and wait for redirect back to Archestra
      await loginViaKeycloak(ssoPage);

      // Verify we're logged in by checking for authenticated UI elements
      // The Keycloak test user matches the Archestra admin user, so SSO should link
      // to the existing account and log us in successfully.
      // The sidebar navigation only appears when logged in
      await ssoPage.waitForLoadState("networkidle");
      // Use text locator as fallback since getByRole can be flaky with complex UIs
      await expect(ssoPage.locator("text=Tools").first()).toBeVisible({
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
    await page.getByText("Generic SAML", { exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Update the domain (use a subdomain to keep it valid for the same email domain)
    await page.getByLabel("Domain").clear();
    await page.getByLabel("Domain").fill(`updated.${SSO_DOMAIN}`);

    // Save changes
    await page.getByRole("button", { name: "Update Provider" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    // STEP 6: Delete the provider
    await page.getByText("Generic SAML", { exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Click delete button
    await page.getByRole("button", { name: "Delete" }).click();

    // Confirm deletion in the confirmation dialog
    await expect(page.getByText(/Are you sure/i)).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    // Wait for dialog to close
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

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
      ).not.toBeVisible({ timeout: 5000 });
    } finally {
      await verifyContext.close();
    }
  });
});

import { UI_BASE_URL } from "../../consts";
import { expect, request as playwrightRequest, test } from "./fixtures";

// Keycloak configuration for e2e tests
// These match the values in helm/e2e-tests/values.yaml
const KEYCLOAK_BASE_URL = "http://localhost:30081";
const KEYCLOAK_REALM = "archestra";
const KEYCLOAK_OIDC_CLIENT_ID = "archestra-oidc";
const KEYCLOAK_OIDC_CLIENT_SECRET = "archestra-oidc-secret";
const KEYCLOAK_TEST_USER = "testuser";
const KEYCLOAK_TEST_PASSWORD = "testpassword";

test.describe("SSO OIDC E2E Flow with Keycloak", () => {
  // Skip if Keycloak is not available
  test.beforeAll(async () => {
    try {
      const request = await playwrightRequest.newContext();
      const response = await request.get(
        `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration`,
      );
      if (!response.ok()) {
        test.skip();
      }
      await request.dispose();
    } catch {
      test.skip();
    }
  });

  test("should configure OIDC provider, login via SSO, update, and delete", async ({
    page,
    browser,
    goToPage,
  }) => {
    const providerName = "Keycloak";

    // STEP 1: Configure the OIDC provider
    await goToPage(page, "/settings/sso-providers");

    // Click on Generic OIDC card
    await page.getByRole("heading", { name: "Generic OIDC" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Fill in Keycloak OIDC configuration
    await page.getByLabel("Provider ID").fill(providerName);
    await page
      .getByLabel("Issuer")
      .fill(`${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}`);
    await page.getByLabel("Domain").fill("archestra.test");
    await page.getByLabel("Client ID").fill(KEYCLOAK_OIDC_CLIENT_ID);
    await page.getByLabel("Client Secret").fill(KEYCLOAK_OIDC_CLIENT_SECRET);
    await page
      .getByLabel("Discovery Endpoint")
      .fill(
        `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration`,
      );

    // Submit the form
    await page.getByRole("button", { name: "Create Provider" }).click();

    // Wait for dialog to close and provider to be created
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    // Verify the provider is now shown as "Enabled"
    // Refresh the page to ensure we see the updated state
    await page.reload();
    await page.waitForLoadState("networkidle");

    // STEP 2: Logout and verify SSO button appears on login page
    // Navigate to settings to find logout
    await page.getByRole("button", { name: /Admin/i }).click();
    await page.getByRole("menuitem", { name: /Sign out/i }).click();

    // Wait for redirect to login page
    await page.waitForURL(/\/auth\/sign-in/);

    // Verify SSO button for Keycloak appears
    await expect(
      page.getByRole("button", { name: new RegExp(providerName, "i") }),
    ).toBeVisible({ timeout: 5000 });

    // STEP 3: Login via SSO with Keycloak
    // Create a new context without stored auth to simulate fresh SSO login
    const ssoContext = await browser.newContext({
      storageState: undefined,
    });
    const ssoPage = await ssoContext.newPage();

    try {
      // Navigate to login page
      await ssoPage.goto(`${UI_BASE_URL}/auth/sign-in`);
      await ssoPage.waitForLoadState("networkidle");

      // Click SSO button
      await ssoPage
        .getByRole("button", { name: new RegExp(providerName, "i") })
        .click();

      // Wait for redirect to Keycloak
      await ssoPage.waitForURL(/.*keycloak.*|.*localhost:30081.*/);

      // Fill in Keycloak login form
      await ssoPage.getByLabel("Username or email").fill(KEYCLOAK_TEST_USER);
      await ssoPage.getByLabel("Password").fill(KEYCLOAK_TEST_PASSWORD);
      await ssoPage.getByRole("button", { name: "Sign In" }).click();

      // Wait for redirect back to Archestra
      await ssoPage.waitForURL(`${UI_BASE_URL}/**`, { timeout: 15000 });

      // Verify we're logged in by checking for user menu
      await expect(
        ssoPage.getByRole("button", { name: /Test User/i }),
      ).toBeVisible({ timeout: 10000 });
    } finally {
      await ssoContext.close();
    }

    // STEP 4: Login again as admin and update the provider
    await goToPage(page, "/settings/sso-providers");

    // The Generic OIDC card should now show "Enabled" since we configured it
    // Click to edit
    await page.getByRole("heading", { name: "Generic OIDC" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Update the domain
    await page.getByLabel("Domain").clear();
    await page.getByLabel("Domain").fill("updated.archestra.test");

    // Save changes
    await page.getByRole("button", { name: "Update Provider" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    // STEP 5: Delete the provider
    await page.getByRole("heading", { name: "Generic OIDC" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Click delete button
    await page.getByRole("button", { name: "Delete" }).click();

    // Confirm deletion in the confirmation dialog
    await expect(page.getByText(/Are you sure/i)).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    // Wait for dialog to close
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    // STEP 6: Verify SSO button no longer appears on login page
    // Logout first
    await page.getByRole("button", { name: /Admin/i }).click();
    await page.getByRole("menuitem", { name: /Sign out/i }).click();
    await page.waitForURL(/\/auth\/sign-in/);

    // SSO button for Keycloak should no longer be visible
    await expect(
      page.getByRole("button", { name: new RegExp(providerName, "i") }),
    ).not.toBeVisible({ timeout: 5000 });
  });
});

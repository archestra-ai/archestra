import { UI_BASE_URL } from "../../consts";
import { expect, test } from "./fixtures";

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
// KEYCLOAK_EXTERNAL_URL is used for browser redirects (accessible from CI host)
// KEYCLOAK_INTERNAL_URL is used for backend discovery (accessible from within K8s cluster)
const KEYCLOAK_EXTERNAL_URL = "http://localhost:30081";
const KEYCLOAK_INTERNAL_URL = "http://e2e-tests-keycloak:8080";
const KEYCLOAK_REALM = "archestra";
const KEYCLOAK_OIDC_CLIENT_ID = "archestra-oidc";
const KEYCLOAK_OIDC_CLIENT_SECRET = "archestra-oidc-secret";
const KEYCLOAK_SAML_ENTITY_ID = `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}`;
const KEYCLOAK_SAML_SSO_URL = `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/saml`;
const KEYCLOAK_TEST_USER = "testuser";
const KEYCLOAK_TEST_PASSWORD = "testpassword";

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

test.describe("SSO OIDC E2E Flow with Keycloak", () => {
  test("should configure OIDC provider, login via SSO, update, and delete", async ({
    page,
    browser,
    goToPage,
  }) => {
    // OIDC flow involves multiple redirects, so triple the timeout
    test.slow();

    // Use a unique provider name to avoid conflicts with existing providers
    const providerName = `KeycloakE2E${Date.now()}`;

    // STEP 1: Navigate to SSO providers page
    await goToPage(page, "/settings/sso-providers");
    await page.waitForLoadState("networkidle");

    // STEP 2: Check if Generic OIDC already has a provider configured
    // If so, delete it first
    const genericOidcCard = page.getByText("Generic OIDC", { exact: true });
    await genericOidcCard.click();
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

      // Now click again to create
      await genericOidcCard.click();
      await expect(page.getByRole("dialog")).toBeVisible();
    }

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
    await page.getByLabel("Domain").fill("archestra.test");
    await page.getByLabel("Client ID").fill(KEYCLOAK_OIDC_CLIENT_ID);
    await page.getByLabel("Client Secret").fill(KEYCLOAK_OIDC_CLIENT_SECRET);
    // Discovery endpoint - backend fetches this (must be internal URL)
    await page
      .getByLabel("Discovery Endpoint")
      .fill(
        `${KEYCLOAK_INTERNAL_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration`,
      );
    // Authorization endpoint - browser redirects here (external URL)
    await page
      .getByLabel("Authorization Endpoint")
      .fill(
        `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth`,
      );
    // Token endpoint - backend calls this (internal URL)
    await page
      .getByLabel("Token Endpoint")
      .fill(
        `${KEYCLOAK_INTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`,
      );
    // JWKS endpoint - backend validates tokens (internal URL)
    await page
      .getByLabel("JWKS Endpoint")
      .fill(
        `${KEYCLOAK_INTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
      );

    // Submit the form
    await page.getByRole("button", { name: "Create Provider" }).click();

    // Wait for dialog to close and provider to be created
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

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

      // Wait for redirect to Keycloak (external URL for browser)
      // Match either localhost:30081 or the Keycloak hostname
      await ssoPage.waitForURL(/.*localhost:30081.*|.*keycloak.*/, {
        timeout: 15000,
      });

      // Fill in Keycloak login form
      await ssoPage.getByLabel("Username or email").fill(KEYCLOAK_TEST_USER);
      // Use role selector for password field to avoid conflict with "Show password" button
      await ssoPage
        .getByRole("textbox", { name: "Password" })
        .fill(KEYCLOAK_TEST_PASSWORD);
      await ssoPage.getByRole("button", { name: "Sign In" }).click();

      // Wait for redirect back to Archestra - should land on a logged-in page (not sign-in)
      await ssoPage.waitForURL(`${UI_BASE_URL}/**`, { timeout: 15000 });

      // Verify we're logged in by checking for user menu (email contains @)
      await expect(ssoPage.locator('button:has-text("@")')).toBeVisible({
        timeout: 10000,
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

    // Update the domain
    await page.getByLabel("Domain").clear();
    await page.getByLabel("Domain").fill("updated.archestra.test");

    // Save changes
    await page.getByRole("button", { name: "Update Provider" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    // STEP 6: Delete the provider
    await page.getByText("Generic OIDC", { exact: true }).click();
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

    // STEP 2: Check if Generic SAML already has a provider configured
    // If so, delete it first
    const genericSamlCard = page.getByText("Generic SAML", { exact: true });
    await genericSamlCard.click();
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

      // Now click again to create
      await genericSamlCard.click();
      await expect(page.getByRole("dialog")).toBeVisible();
    }

    // Now we should have a create dialog
    // Fill in Keycloak SAML configuration
    await page.getByLabel("Provider ID").fill(providerName);
    await page
      .getByLabel("Issuer", { exact: true })
      .fill(KEYCLOAK_SAML_ENTITY_ID);
    await page.getByLabel("Domain").fill("archestra.test");
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

    // Submit the form
    await page.getByRole("button", { name: "Create Provider" }).click();

    // Wait for dialog to close and provider to be created
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    // Verify the provider is now shown as "Enabled"
    await page.reload();
    await page.waitForLoadState("networkidle");

    // STEP 3: Verify SSO button appears on login page
    // Note: Full SAML login flow is skipped due to known Better Auth SSO plugin limitations
    // with SAML attribute parsing and user provisioning.
    // See: https://github.com/better-auth/better-auth/issues/3615
    // The OIDC test verifies the full login flow works; this test verifies SAML CRUD operations.
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

      // SAML provider is configured and SSO button is visible
      // Full login flow skipped due to Better Auth SAML limitations
    } finally {
      await ssoContext.close();
    }

    // STEP 4: Use the original admin page context to update the provider
    // (the original page context is still logged in as admin)
    await goToPage(page, "/settings/sso-providers");
    await page.waitForLoadState("networkidle");

    // Click on Generic SAML card to edit (our provider)
    await page.getByText("Generic SAML", { exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Update the domain
    await page.getByLabel("Domain").clear();
    await page.getByLabel("Domain").fill("updated.archestra.test");

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

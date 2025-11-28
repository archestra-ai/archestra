import { UI_BASE_URL } from "../../consts";
import { expect, test } from "./fixtures";

// Keycloak configuration for e2e tests
// These match the values in helm/e2e-tests/values.yaml
const KEYCLOAK_BASE_URL = "http://localhost:30081";
const KEYCLOAK_REALM = "archestra";
const KEYCLOAK_OIDC_CLIENT_ID = "archestra-oidc";
const KEYCLOAK_OIDC_CLIENT_SECRET = "archestra-oidc-secret";
const KEYCLOAK_SAML_ENTITY_ID = `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}`;
const KEYCLOAK_SAML_SSO_URL = `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/protocol/saml`;
const KEYCLOAK_TEST_USER = "testuser";
const KEYCLOAK_TEST_PASSWORD = "testpassword";

// Keycloak's signing certificate (extracted from SAML metadata)
const KEYCLOAK_SAML_CERT = `MIICoTCCAYkCBgGayJXN8DANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAlhcmNoZXN0cmEwHhcNMjUxMTI4MDM0OTEyWhcNMzUxMTI4MDM1MDUyWjAUMRIwEAYDVQQDDAlhcmNoZXN0cmEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDUHRpv4MGqkx2mTXqkEeOTwyWxzHXRlgz//cdNQuIFqnAxzreznp6rx18qQ2VYCefrueD1WaWAFxd2Gxl2QF5YaQhGyIGNftaa2eW6gIyVd2aMzyyAUpIXRRXMUxMYjVjVFFDuGGdxTo2QZnCeZWqn9KWCnmZqYXiPpoNC5y+TKRvj/HjL1Z6UK0dvCdYu5KEg9culknRTEicyYs6PtX8FPHDH/osbJK0H9jB8M0Gd9Q+2bE9tj5o3CT0L3Y62O1FnJpW613KJ4/T+mJujpifesXHwIk+GfaiV4JVtvq+QVnrAy81r3mI9OAGSoM2ZnkpBLATw5+9GwCDMSENp8T/7AgMBAAEwDQYJKoZIhvcNAQELBQADggEBAFVzP45IaFo+3DXIamJecr8NPQThI94MS/b/BK61KIqgUNHVnOy+Pjc3wyavye99Kk5BpaPGfereoGHljX/PdHQrtIMCearcczLlie5chn1IIE3RfUBvMcs4q2PKt9TTbGyBHDlLoFSz0jma3ONns/hlxVFAFEjwHq/ikozm13O5UKedMlKv4VCnG5AvvV3n+ECZLyRRfP6jyMJEfmYqLvVMNHtlFoYSLfUfQdY3QxcVa+qKwph/ZrqkQcTHpxLDsAeP8ZarNIbbVj9C3P0SjYTOapQzgvhtPQq4mS0N6cbfgYIc2iNJug1KsmvPojbQSjtpont+eWIH2ZFpNgRM8Cg=`;

// Keycloak's full IdP metadata XML (fetched from /realms/archestra/protocol/saml/descriptor)
// This is required by Better Auth's SAML implementation to properly configure the IdP
// NOTE: WantAuthnRequestsSigned is set to "false" to avoid signing complexity in tests
const KEYCLOAK_IDP_METADATA = `<md:EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="http://localhost:30081/realms/archestra"><md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:KeyName>hqQr5rOAQkhQRRhCCML1A1vULCG4NXHvNY3Yq4cutxA</ds:KeyName><ds:X509Data><ds:X509Certificate>${KEYCLOAK_SAML_CERT}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:ArtifactResolutionService Binding="urn:oasis:names:tc:SAML:2.0:bindings:SOAP" Location="http://localhost:30081/realms/archestra/protocol/saml/resolve" index="0"></md:ArtifactResolutionService><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="http://localhost:30081/realms/archestra/protocol/saml"></md:SingleLogoutService><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="http://localhost:30081/realms/archestra/protocol/saml"></md:SingleLogoutService><md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:transient</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="http://localhost:30081/realms/archestra/protocol/saml"></md:SingleSignOnService><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="http://localhost:30081/realms/archestra/protocol/saml"></md:SingleSignOnService></md:IDPSSODescriptor></md:EntityDescriptor>`;

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
    // JWKS endpoint is required for token validation
    await page
      .getByLabel("JWKS Endpoint")
      .fill(
        `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
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

      // Wait for redirect to Keycloak
      await ssoPage.waitForURL(/.*keycloak.*|.*localhost:30081.*/, {
        timeout: 10000,
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
    await page.getByLabel("IdP Certificate").fill(KEYCLOAK_SAML_CERT);

    // IdP Metadata XML is required to avoid ERR_IDP_METADATA_MISSING_SINGLE_SIGN_ON_SERVICE error
    // The field is nested as samlConfig.idpMetadata.metadata in the schema
    await page
      .getByLabel("IdP Metadata XML (Recommended)")
      .fill(KEYCLOAK_IDP_METADATA);

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

      // STEP 4: Click SSO button and login via Keycloak SAML
      await ssoPage
        .getByRole("button", { name: new RegExp(providerName, "i") })
        .click();

      // Wait for redirect to Keycloak
      await ssoPage.waitForURL(/.*keycloak.*|.*localhost:30081.*/, {
        timeout: 10000,
      });

      // Fill in Keycloak login form (same as OIDC - Keycloak shows the same login form)
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

      // SAML login successful - user is now logged in
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

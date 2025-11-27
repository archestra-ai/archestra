import { expect } from "@playwright/test";
import { test } from "./fixtures";

test.describe("SSO Providers Management UI", () => {
  test("should display SSO providers page", async ({ page, goToPage }) => {
    await goToPage(page, "/settings/sso-providers");

    // Check page title and description
    await expect(
      page.getByRole("heading", { name: "SSO Providers" }),
    ).toBeVisible();
    await expect(
      page.getByText("Manage Single Sign-On (SSO) providers"),
    ).toBeVisible();

    // Check for Add SSO Provider button
    await expect(
      page.getByRole("button", { name: "Add SSO Provider" }),
    ).toBeVisible();
  });

  test("should show empty state when no providers exist", async ({
    page,
    goToPage,
  }) => {
    await goToPage(page, "/settings/sso-providers");

    // Should show empty state message
    await expect(
      page.getByText("No SSO providers configured yet"),
    ).toBeVisible();
    await expect(page.getByText("Add your first SSO provider")).toBeVisible();
  });

  test("should open create SSO provider dialog", async ({ page, goToPage }) => {
    await goToPage(page, "/settings/sso-providers");

    // Click Add SSO Provider button
    await page.getByRole("button", { name: "Add SSO Provider" }).click();

    // Check dialog is open
    await expect(
      page.getByRole("dialog", { name: "Add SSO Provider" }),
    ).toBeVisible();
    await expect(
      page.getByText("Configure a new Single Sign-On provider"),
    ).toBeVisible();

    // Check basic form fields are present
    await expect(page.getByLabel("Provider ID")).toBeVisible();
    await expect(page.getByLabel("Issuer")).toBeVisible();
    await expect(page.getByLabel("Domain")).toBeVisible();
    await expect(page.getByLabel("Provider Type")).toBeVisible();

    // Check tabs
    await expect(
      page.getByRole("tab", { name: "Basic Configuration" }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Provider Configuration" }),
    ).toBeVisible();

    // Close dialog
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("dialog", { name: "Add SSO Provider" }),
    ).not.toBeVisible();
  });

  test("should switch between OIDC and SAML configuration", async ({
    page,
    goToPage,
  }) => {
    await goToPage(page, "/settings/sso-providers");

    // Open create dialog
    await page.getByRole("button", { name: "Add SSO Provider" }).click();

    // Go to Provider Configuration tab
    await page.getByRole("tab", { name: "Provider Configuration" }).click();

    // Should show OIDC config by default
    await expect(page.getByText("OIDC Configuration")).toBeVisible();
    await expect(page.getByLabel("Client ID")).toBeVisible();

    // Switch to Basic Configuration tab and change provider type
    await page.getByRole("tab", { name: "Basic Configuration" }).click();
    await page.getByLabel("Provider Type").click();
    await page.getByRole("option", { name: "SAML 2.0" }).click();

    // Go back to Provider Configuration tab
    await page.getByRole("tab", { name: "Provider Configuration" }).click();

    // Should now show SAML config
    await expect(page.getByText("SAML Configuration")).toBeVisible();
    await expect(page.getByLabel("Entry Point (SSO URL)")).toBeVisible();

    // Close dialog
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  test("should validate required fields", async ({ page, goToPage }) => {
    await goToPage(page, "/settings/sso-providers");

    // Open create dialog
    await page.getByRole("button", { name: "Add SSO Provider" }).click();

    // Try to submit without filling required fields
    await page.getByRole("button", { name: "Create Provider" }).click();

    // Should show validation errors
    await expect(page.getByText("Provider ID is required")).toBeVisible();
    await expect(page.getByText("Issuer is required")).toBeVisible();
    await expect(page.getByText("Domain is required")).toBeVisible();

    // Close dialog
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  test("should fill OIDC configuration form", async ({ page, goToPage }) => {
    await goToPage(page, "/settings/sso-providers");

    // Open create dialog
    await page.getByRole("button", { name: "Add SSO Provider" }).click();

    // Fill basic configuration
    await page.getByLabel("Provider ID").fill("test-oidc-provider");
    await page.getByLabel("Issuer").fill("https://auth.example.com");
    await page.getByLabel("Domain").fill("example.com");

    // Go to Provider Configuration tab
    await page.getByRole("tab", { name: "Provider Configuration" }).click();

    // Fill OIDC configuration
    await page.getByLabel("Client ID").fill("test-client-id");
    await page.getByLabel("Client Secret").fill("test-client-secret");
    await page
      .getByLabel("Discovery Endpoint")
      .fill("https://auth.example.com/.well-known/openid-configuration");

    // Check that form is filled
    await expect(page.getByLabel("Client ID")).toHaveValue("test-client-id");
    await expect(page.getByLabel("Client Secret")).toHaveValue(
      "test-client-secret",
    );

    // Close dialog
    await page.getByRole("button", { name: "Cancel" }).click();
  });
});

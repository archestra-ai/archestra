import { expect, goToPage, test } from "../../fixtures";

test.describe("Organization Settings page", () => {
  test("should navigate to /settings/organization and show sections", async ({
    page,
  }) => {
    await goToPage(page, "/settings/organization");

    // Appearance section
    await expect(page.getByText("Appearance")).toBeVisible();
    await expect(page.getByText("Theme")).toBeVisible();

    // Auth section
    await expect(
      page.getByRole("heading", { name: "Authentication" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Two-Factor Authentication" }),
    ).toBeVisible();
  });

  test("should redirect from /settings/appearance to /settings/organization", async ({
    page,
  }) => {
    await goToPage(page, "/settings/appearance");
    await page.waitForURL("**/settings/organization");
    expect(page.url()).toContain("/settings/organization");
  });

  test("should show branding fields (App Name, Footer Text, OG Description)", async ({
    page,
  }) => {
    await goToPage(page, "/settings/organization");

    await expect(page.getByLabel("App Name")).toBeVisible();
    await expect(page.getByLabel("Footer Text")).toBeVisible();
    await expect(page.getByLabel("OG Description")).toBeVisible();
  });

  test("should show chat placeholders editor", async ({ page }) => {
    await goToPage(page, "/settings/organization");

    await expect(page.getByText("Chat Placeholders")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add Placeholder" }),
    ).toBeVisible();
  });
});

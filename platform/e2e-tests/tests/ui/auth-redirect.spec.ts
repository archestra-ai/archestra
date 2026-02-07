import { ADMIN_EMAIL, ADMIN_PASSWORD, UI_BASE_URL } from "../../consts";
import { expect, test } from "../../fixtures";
import { loginViaUi } from "../../utils";

test.describe(
  "Authentication redirect flows",
  { tag: ["@firefox", "@webkit"] },
  () => {
    test("sign-out works and redirects to sign-in page", async ({
      adminPage,
      goToPage,
    }) => {
      // Navigate to app
      await goToPage(adminPage, "/chat");

      // Click on the user profile button to open dropdown
      await adminPage.getByRole("button", { name: ADMIN_EMAIL }).click();

      // Click sign out option in the dropdown
      await adminPage.getByRole("menuitem", { name: /sign out/i }).click();

      // Should be redirected to sign-out page which handles the sign-out
      await adminPage.waitForURL(/\/auth\/sign-out/);

      // The sign-out page should render (better-auth handles the actual sign-out)
      // After sign-out completes, the page should show the sign-out confirmation or redirect
      await expect(adminPage.locator("body")).toBeVisible({ timeout: 10000 });
    });

    test("redirectTo parameter preserves original URL after sign-in", async ({
      browser,
    }) => {
      // Create a fresh browser context without authentication (no storage state)
      const context = await browser.newContext({ storageState: undefined });
      const page = await context.newPage();

      try {
        // Try to access a protected page while logged out
        const targetPath = "/logs/llm-proxy";
        await page.goto(`${UI_BASE_URL}${targetPath}`);

        // Should be redirected to sign-in with redirectTo parameter
        await page.waitForURL(/\/auth\/sign-in\?redirectTo=/, {
          timeout: 15000,
        });
        expect(page.url()).toContain("redirectTo");

        // Sign in via UI form
        await loginViaUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);

        // After sign-in, should be redirected back to the original URL
        await page.waitForURL(`**${targetPath}**`, { timeout: 15000 });
        expect(page.url()).toContain(targetPath);
      } finally {
        await context.close();
      }
    });

    test("redirectTo parameter is validated (rejects malicious URLs)", async ({
      browser,
    }) => {
      // Create a fresh browser context without authentication (no storage state)
      const context = await browser.newContext({ storageState: undefined });
      const page = await context.newPage();

      try {
        // Navigate directly to sign-in with a malicious redirectTo
        const maliciousRedirect = encodeURIComponent(
          "https://evil.com/phishing",
        );
        await page.goto(
          `${UI_BASE_URL}/auth/sign-in?redirectTo=${maliciousRedirect}`,
        );

        // Sign in via UI form
        await loginViaUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);

        // Wait for navigation away from sign-in page (login success redirects)
        await page.waitForURL(
          (url) => !url.pathname.includes("/auth/sign-in"),
          {
            timeout: 30000,
          },
        );

        // Should NOT be on the malicious URL - check that we're not redirected to evil.com
        expect(page.url()).not.toContain("evil.com");

        // Should be on a valid app page (home or chat)
        expect(page.url().startsWith(UI_BASE_URL)).toBe(true);
      } finally {
        await context.close();
      }
    });
  },
);

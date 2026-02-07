import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  UI_BASE_URL,
} from "../../consts";
import { expect, test } from "../../fixtures";

test.describe("Origin error handling", { tag: ["@firefox", "@webkit"] }, () => {
  test("login from localhost succeeds (baseline)", async ({
    browser,
  }) => {
    // Use a fresh unauthenticated context
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(`${UI_BASE_URL}/auth/sign-in`);
      await page.waitForLoadState("networkidle");

      // Fill in credentials and submit
      await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
      await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: /sign in/i }).click();

      // Should redirect away from sign-in page on success
      await page.waitForURL((url) => !url.pathname.includes("/auth/sign-in"), {
        timeout: 15_000,
      });
    } finally {
      await context.close();
    }
  });

  test("origin error shows helpful message when backend returns 403", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // Intercept sign-in requests to simulate a 403 "Invalid origin" response
      await page.route("**/api/auth/sign-in/**", (route) => {
        route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            message:
              "Invalid origin: http://192.168.5.23:3000 is not in the list of trusted origins.",
            trustedOrigins: ["http://localhost:3000"],
          }),
        });
      });

      await page.goto(`${UI_BASE_URL}/auth/sign-in`);
      await page.waitForLoadState("networkidle");

      // Fill in credentials and submit to trigger the intercepted request
      await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
      await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: /sign in/i }).click();

      // Verify the origin error alert is displayed
      await expect(
        page.getByText("Origin Not Allowed"),
      ).toBeVisible({ timeout: 10_000 });

      // Verify env var instructions are present
      await expect(
        page.getByText("ARCHESTRA_FRONTEND_URL="),
      ).toBeVisible();

      // Verify the additional trusted origins env var is mentioned
      await expect(
        page.getByText("ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS"),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("login from 127.0.0.1 succeeds", async ({
    browser,
  }) => {
    // Use a fresh unauthenticated context
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // Navigate using 127.0.0.1 instead of localhost
      const url127 = UI_BASE_URL.replace("localhost", "127.0.0.1");
      await page.goto(`${url127}/auth/sign-in`);
      await page.waitForLoadState("networkidle");

      // Fill in credentials and submit
      await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
      await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: /sign in/i }).click();

      // Should redirect away from sign-in page on success
      await page.waitForURL((url) => !url.pathname.includes("/auth/sign-in"), {
        timeout: 15_000,
      });
    } finally {
      await context.close();
    }
  });
});

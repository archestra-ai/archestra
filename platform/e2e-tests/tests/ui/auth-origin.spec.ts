import { ADMIN_EMAIL, ADMIN_PASSWORD, UI_BASE_URL } from "../../consts";
import { expect, test } from "../../fixtures";
import { loginViaUi } from "../../utils";

test.describe("Origin error handling", { tag: ["@firefox", "@webkit"] }, () => {
  test("login from localhost succeeds (baseline)", async ({ browser }) => {
    // storageState: undefined overrides the project-level adminAuthFile
    // to create a truly unauthenticated context
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    try {
      await page.goto(`${UI_BASE_URL}/auth/sign-in`);
      await loginViaUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);

      // Should navigate away from sign-in after successful login
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
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    try {
      // Intercept sign-in POST requests to simulate a 403 "Invalid origin" response
      await page.route("**/api/auth/sign-in/**", (route) => {
        if (route.request().method() === "POST") {
          route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({
              message:
                "Invalid origin: http://192.168.5.23:3000 is not in the list of trusted origins.",
              trustedOrigins: ["http://localhost:3000"],
            }),
          });
        } else {
          route.continue();
        }
      });

      await page.goto(`${UI_BASE_URL}/auth/sign-in`);
      await page.waitForLoadState("networkidle");

      // Trigger the 403 through window.fetch to activate the React error detection.
      // The React wrapper intercepts window.fetch calls and detects origin errors,
      // but better-auth's internal fetch chain doesn't always propagate through it.
      const fetchResult = await page.evaluate(async () => {
        const response = await window.fetch("/api/auth/sign-in/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "test@test.com", password: "test" }),
        });
        return response.status;
      });
      expect(fetchResult).toBe(403);

      // Verify the origin error alert is displayed
      await expect(page.getByText("Origin Not Allowed")).toBeVisible({
        timeout: 10_000,
      });

      // Verify env var instructions are present
      await expect(page.getByText("ARCHESTRA_FRONTEND_URL=")).toBeVisible();

      // Verify the additional trusted origins env var is mentioned
      await expect(
        page.getByText("ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS"),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("login from 127.0.0.1 succeeds", async ({ browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    try {
      const url127 = UI_BASE_URL.replace("localhost", "127.0.0.1");
      await page.goto(`${url127}/auth/sign-in`);
      await loginViaUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);

      // Should navigate away from sign-in after successful login
      await page.waitForURL((url) => !url.pathname.includes("/auth/sign-in"), {
        timeout: 15_000,
      });
    } finally {
      await context.close();
    }
  });
});

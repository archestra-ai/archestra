import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  E2eTestId,
  UI_BASE_URL,
} from "./consts";

const authFile = path.join(__dirname, "playwright/.auth/user.json");

setup("authenticate", async ({ page }) => {
  // Perform authentication steps
  await page.goto(`${UI_BASE_URL}/auth/sign-in`);
  await page.getByRole("textbox", { name: "Email" }).fill(DEFAULT_ADMIN_EMAIL);
  await page
    .getByRole("textbox", { name: "Password" })
    .fill(DEFAULT_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Login" }).click();

  // Wait until the page redirects to the authenticated area
  await page.waitForURL(`${UI_BASE_URL}/test-agent`);

  // Skip onboarding dialog if it appears (for fresh environments)
  const skipButton = page.getByTestId(E2eTestId.OnboardingSkipButton);
  if (await skipButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await skipButton.click();
    // Wait for dialog to close
    await page.waitForTimeout(500);
  }

  // Verify we're authenticated by checking for user profile or similar
  await expect(page.getByRole("button", { name: /Admin/i })).toBeVisible();

  // Save the authentication state to a file
  await page.context().storageState({ path: authFile });
});

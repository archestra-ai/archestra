import { expect, test as setup } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  adminAuthFile,
  UI_BASE_URL,
} from "./consts";
import { loginViaApi } from "./utils";

// Setup admin authentication - must run first before other users
setup("authenticate as admin", async ({ page }) => {
  // Sign in admin via API
  const signedIn = await loginViaApi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  expect(signedIn, "Admin sign-in failed").toBe(true);

  // Navigate to trigger cookie storage
  await page.goto(`${UI_BASE_URL}/chat`);
  await page.waitForLoadState("networkidle");

  // Mark onboarding as complete via API
  await page.request.patch(`${UI_BASE_URL}/api/organization`, {
    data: { onboardingComplete: true },
  });

  // Reload page to dismiss onboarding dialog (on fresh env it renders before API call)
  await page.reload();
  await page.waitForLoadState("networkidle");

  // Verify we're authenticated
  await expect(page.getByRole("link", { name: /Tools/i })).toBeVisible({
    timeout: 30000,
  });

  // Save admin auth state
  await page.context().storageState({ path: adminAuthFile });
});

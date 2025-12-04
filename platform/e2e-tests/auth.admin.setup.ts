import { expect, test as setup } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  adminAuthFile,
  UI_BASE_URL,
} from "./consts";

/**
 * Sign in a user via API and return true if successful
 */
async function signInAdmin(
  request: Parameters<Parameters<typeof setup>[1]>[0]["page"]["request"],
  email: string,
  password: string,
): Promise<boolean> {
  const response = await request.post(`${UI_BASE_URL}/api/auth/sign-in/email`, {
    data: { email, password },
    headers: {
      Origin: UI_BASE_URL,
    },
  });
  return response.ok();
}

// Setup admin authentication - must run first before other users
setup("authenticate as admin", async ({ page }) => {
  // Sign in admin via API
  const signedIn = await signInAdmin(page.request, ADMIN_EMAIL, ADMIN_PASSWORD);
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

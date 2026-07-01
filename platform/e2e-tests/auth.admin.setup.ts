import { expect, test as setup } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  adminAuthFile,
  UI_BASE_URL,
} from "./consts";
import { expectAuthenticated, loginViaApi } from "./utils";

// Setup admin authentication - must run first before other users
setup("authenticate as admin", async ({ page }) => {
  // Sign in admin via API
  const signedIn = await loginViaApi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  expect(signedIn, "Admin sign-in failed").toBe(true);

  // Navigate to trigger cookie storage
  await page.goto(`${UI_BASE_URL}/chat`, { waitUntil: "domcontentloaded" });

  // Mark onboarding as complete and set restrictive tool policies via API.
  // Proxy-discovered tools use a separate policy switch, so set both.
  await page.request.post(
    `${UI_BASE_URL}/api/organization/complete-onboarding`,
    { data: { onboardingComplete: true } },
  );
  const securitySettingsResponse = await page.request.patch(
    `${UI_BASE_URL}/api/organization/security-settings`,
    {
      data: {
        globalToolPolicy: "restrictive",
        discoveredToolPolicy: "apply_policies",
      },
    },
  );
  expect(securitySettingsResponse.ok()).toBe(true);

  // Reload page to dismiss onboarding dialog (on fresh env it renders before API call)
  await page.reload({ waitUntil: "domcontentloaded" });

  // Verify we're authenticated
  await expectAuthenticated(page);

  // Save admin auth state
  await page.context().storageState({ path: adminAuthFile });
});

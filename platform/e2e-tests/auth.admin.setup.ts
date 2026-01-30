import { expect, test as setup } from "@playwright/test";
import { SecretsManagerType } from "@shared";
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
  await page.goto(`${UI_BASE_URL}/chat`, { waitUntil: "domcontentloaded" });

  // Mark onboarding as complete and set restrictive policy via API
  // Setting globalToolPolicy to "restrictive" prevents the permissive policy overlay from blocking UI interactions
  await page.request.patch(`${UI_BASE_URL}/api/organization`, {
    data: { onboardingComplete: true, globalToolPolicy: "restrictive" },
  });

  // Initialize secrets manager to DB mode for all shards
  // This is required because sharded test runs are independent, and most tests rely on DB mode.
  // The credentials-with-vault.ee.spec.ts test will override this to test Vault integration,
  // then switch back to DB mode. Other shards that don't run that test will already be in DB mode.
  await page.request.post(
    `${UI_BASE_URL}/api/secrets/initialize-secrets-manager`,
    {
      data: { type: SecretsManagerType.DB },
    },
  );

  // Reload page to dismiss onboarding dialog (on fresh env it renders before API call)
  await page.reload({ waitUntil: "domcontentloaded" });

  // Verify we're authenticated
  await expect(page.getByRole("link", { name: /Tool Policies/i })).toBeVisible({
    timeout: 30000,
  });

  // Save admin auth state
  await page.context().storageState({ path: adminAuthFile });
});

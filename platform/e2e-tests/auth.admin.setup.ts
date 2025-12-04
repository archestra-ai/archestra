import { expect, test as setup } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  adminAuthFile,
  UI_BASE_URL,
} from "./consts";

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sign in a user via API and return true if successful
 * Handles rate limiting (429) with exponential backoff retry
 */
async function signInAdmin(
  request: Parameters<Parameters<typeof setup>[1]>[0]["page"]["request"],
  email: string,
  password: string,
): Promise<boolean> {
  const maxRetries = 3;
  let delay = 1000; // Start with 1 second delay

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await request.post(
      `${UI_BASE_URL}/api/auth/sign-in/email`,
      {
        data: { email, password },
        headers: {
          Origin: UI_BASE_URL,
        },
      },
    );

    if (response.ok()) {
      return true;
    }

    // If rate limited and we have retries left, wait and retry
    if (response.status() === 429 && attempt < maxRetries) {
      await sleep(delay);
      delay *= 2; // Exponential backoff
      continue;
    }

    // For other errors or final retry, return false
    return false;
  }

  return false;
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

import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import dotenv from "dotenv";
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  UI_BASE_URL,
} from "./consts";

const authFile = path.join(__dirname, "playwright/.auth/user.json");

/**
 * Load .env from platform root
 */
dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const ADMIN_EMAIL =
  process.env.ARCHESTRA_AUTH_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
const ADMIN_PASSWORD =
  process.env.ARCHESTRA_AUTH_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;

setup("authenticate", async ({ page }) => {
  // Perform authentication steps
  await page.goto(`${UI_BASE_URL}/auth/sign-in`);
  await page.getByRole("textbox", { name: "Email" }).fill(ADMIN_EMAIL);
  await page.getByRole("textbox", { name: "Password" }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Login" }).click();

  // Wait until the page redirects to the authenticated area
  await page.waitForURL(`${UI_BASE_URL}/chat`);

  // Mark onboarding as complete by updating the organization
  // This prevents the onboarding dialog from appearing in tests
  await page.request.patch(`${UI_BASE_URL}/api/organization`, {
    data: {
      onboardingComplete: true,
    },
  });

  // Wait for page to refresh after onboarding completion
  await page.waitForTimeout(1000);

  // Verify we're authenticated by checking for user profile or similar
  await expect(page.getByRole("link", { name: /Tools/i })).toBeVisible({
    timeout: 10000,
  });

  // Save the authentication state to a file
  await page.context().storageState({ path: authFile });
});

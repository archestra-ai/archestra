import { test as setup, expect } from '@playwright/test';
import path from 'path';
import { BASE_URL } from './utils';

const authFile = path.join(__dirname, 'playwright/.auth/user.json');

setup('authenticate', async ({ page }) => {
  // Perform authentication steps
  await page.goto(`${BASE_URL}/auth/sign-in`);
  await page.getByRole('textbox', { name: 'Email' }).fill('admin@example.com');
  await page.getByRole('textbox', { name: 'Password' }).fill('admin123');
  await page.getByRole('button', { name: 'Login' }).click();

  // Wait until the page redirects to the authenticated area
  await page.waitForURL(`${BASE_URL}/test-agent`);

  // Verify we're authenticated by checking for user profile or similar
  await expect(page.getByRole('button', { name: /Admin/i })).toBeVisible();

  // Save the authentication state to a file
  await page.context().storageState({ path: authFile });
});

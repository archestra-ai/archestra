import { test, expect } from '@playwright/test';
import { E2eTestId } from '@shared';
import { goToPage } from '../utils';

test('has `How it works` heading on home page', async ({ page }) => {
  await goToPage(page);

  await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
});

test('has demo agents', async ({ page }) => {
  await goToPage(page, '/agents');

  await expect(page.getByTestId(E2eTestId.AgentsTable).getByText("Demo Agent without Archestra")).toBeVisible();
  await expect(page.getByTestId(E2eTestId.AgentsTable).getByText("Demo Agent with Archestra")).toBeVisible();
});

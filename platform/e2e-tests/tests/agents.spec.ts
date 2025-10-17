import { test, expect } from '@playwright/test';
import { E2eTestId } from '@shared';
import { getRandomString, goToPage } from '../utils';

test('can create and delete an agent', async ({ page }) => {
  const AGENT_NAME = getRandomString(10, 'Test Agent');
  await goToPage(page, '/agents');
  await page.getByTestId(E2eTestId.CreateAgentButton).click();
  await page.getByRole('textbox', { name: 'Name' }).fill(AGENT_NAME);
  await page.locator("[type=submit]").click();
  await page.waitForTimeout(1000);

  // Close the "How to connect" modal which shows up after creating an agent
  await page.getByTestId(E2eTestId.CreateAgentCloseHowToConnectButton).click();

  // Check if the agent is created
  await expect(page.getByTestId(E2eTestId.AgentsTable).getByText(AGENT_NAME)).toBeVisible();

  // Delete created agent - first open the dropdown which contains the action buttons
  await page.getByTestId(`${E2eTestId.AgentActionsDropdownTrigger}-${AGENT_NAME}`).click();
  await page.getByTestId(`${E2eTestId.DeleteAgentButton}-${AGENT_NAME}`).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId(E2eTestId.AgentsTable).getByText(AGENT_NAME)).not.toBeVisible();
});

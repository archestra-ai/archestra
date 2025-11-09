import { E2eTestId } from "@shared";
import { expect, test } from "./fixtures";

test("can create and delete an agent", async ({
  page,
  makeRandomString,
  goToPage,
}) => {
  // Skip onboarding if dialog is present
  const skipButton = page.getByTestId(E2eTestId.OnboardingSkipButton);
  if (await skipButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await skipButton.click();
    // Wait for dialog to close
    await page.waitForTimeout(500);
  }

  const AGENT_NAME = makeRandomString(10, "Test Agent");
  await goToPage(page, "/agents");
  await page.getByTestId(E2eTestId.CreateAgentButton).click();
  await page.getByRole("textbox", { name: "Name" }).fill(AGENT_NAME);
  await page.locator("[type=submit]").click();
  await page.waitForTimeout(1000);

  // Close the "How to connect" modal which shows up after creating an agent
  await page.getByTestId(E2eTestId.CreateAgentCloseHowToConnectButton).click();

  // Check if the agent is created
  await expect(
    page.getByTestId(E2eTestId.AgentsTable).getByText(AGENT_NAME),
  ).toBeVisible();

  // Delete created agent - click the delete button directly
  await page
    .getByTestId(`${E2eTestId.DeleteAgentButton}-${AGENT_NAME}`)
    .click();
  await page.getByRole("button", { name: "Delete" }).click();

  await expect(
    page.getByTestId(E2eTestId.AgentsTable).getByText(AGENT_NAME),
  ).not.toBeVisible();
});

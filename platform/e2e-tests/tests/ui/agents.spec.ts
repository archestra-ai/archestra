import { E2eTestId } from "@shared";
import { expect, test } from "../../fixtures";
import { clickButton } from "../../utils";

test(
  "can create and delete a profile",
  { tag: ["@firefox", "@webkit"] },
  async ({ page, makeRandomString, goToPage }) => {
    // Skip onboarding if dialog is present
    const skipButton = page.getByTestId(E2eTestId.OnboardingSkipButton);
    if (await skipButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipButton.click();
      // Wait for dialog to close
      await page.waitForTimeout(500);
    }

    const AGENT_NAME = makeRandomString(10, "Test Profile");
    await goToPage(page, "/profiles");
    await page.getByTestId(E2eTestId.CreateAgentButton).click();
    await page.getByRole("textbox", { name: "Name" }).fill(AGENT_NAME);
    await page.locator("[type=submit]").click();

    // After profile creation, dialog transitions to "How to connect" view
    // Wait for the success dialog to appear with connection instructions
    await expect(
      page.getByText(new RegExp(`How to connect "${AGENT_NAME}"`, "i")),
    ).toBeVisible({ timeout: 45000 });

    // Click Close button to dismiss the dialog
    await page
      .getByTestId(E2eTestId.CreateAgentCloseHowToConnectButton)
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });
    await page.waitForLoadState("networkidle");

    // Poll for the profile to appear in the table (handles async creation)
    const profileLocator = page
      .getByTestId(E2eTestId.AgentsTable)
      .getByText(AGENT_NAME);

    await expect(async () => {
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(profileLocator).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 30_000, intervals: [2000, 3000, 5000] });

    // Delete created profile - click the delete button directly
    await page
      .getByTestId(`${E2eTestId.DeleteAgentButton}-${AGENT_NAME}`)
      .click();
    await clickButton({ page, options: { name: "Delete profile" } });

    // Wait for deletion to complete
    await expect(profileLocator).not.toBeVisible({ timeout: 10000 });
  },
);

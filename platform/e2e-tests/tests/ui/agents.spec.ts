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

    // After profile creation, wait for the success toast to appear
    await expect(page.getByText("Profile created successfully")).toBeVisible({
      timeout: 15_000,
    });

    // A new dialog opens with connection instructions
    // Wait for the "Connect via" dialog to appear
    await expect(
      page.getByRole("heading", {
        name: new RegExp(`Connect via.*${AGENT_NAME}`, "i"),
      }),
    ).toBeVisible({ timeout: 15_000 });

    // Close the connection dialog by clicking the "Done" button
    await page.getByRole("button", { name: "Done" }).click();

    // Ensure dialog is closed
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

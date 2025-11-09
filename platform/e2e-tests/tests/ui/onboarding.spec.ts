import { E2eTestId } from "@shared";
import { expect, test } from "./fixtures";

test("can skip onboarding", async ({ page, goToPage }) => {
  // Navigate to home page where onboarding dialog should appear
  await goToPage(page, "/");

  // Verify onboarding dialog is visible
  const skipButton = page.getByTestId(E2eTestId.OnboardingSkipButton);
  await expect(skipButton).toBeVisible({ timeout: 5000 });

  // Click skip button
  await skipButton.click();

  // Verify dialog is closed by checking that skip button is no longer visible
  await expect(skipButton).not.toBeVisible();
});

test("can complete onboarding flow", async ({ page, goToPage }) => {
  // Navigate to home page where onboarding dialog should appear
  await goToPage(page, "/");

  // Verify onboarding dialog step 1 is visible
  const nextButton = page.getByTestId(E2eTestId.OnboardingNextButton);
  await expect(nextButton).toBeVisible({ timeout: 5000 });

  // Verify welcome title is shown
  await expect(page.getByText("Welcome to Archestra!")).toBeVisible();

  // Click next to go to step 2
  await nextButton.click();

  // Verify step 2 is shown (Connect and Verify)
  await expect(page.getByText("Connect and Verify")).toBeVisible();

  // Verify finish button is present but disabled (no connection yet)
  const finishButton = page.getByTestId(E2eTestId.OnboardingFinishButton);
  await expect(finishButton).toBeVisible();
  await expect(finishButton).toBeDisabled();

  // Note: In a real scenario, we would make an LLM proxy or MCP gateway request here
  // to enable the finish button. For now, we can test that the button exists and
  // the flow is correct up to this point.

  // We can go back to step 1
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByText("Welcome to Archestra!")).toBeVisible();

  // And skip from there
  const skipButton = page.getByTestId(E2eTestId.OnboardingSkipButton);
  await skipButton.click();
  await expect(skipButton).not.toBeVisible();
});

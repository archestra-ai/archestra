import { E2eTestId } from "@shared";
import { expect, test } from "./fixtures";

test.describe("Invitation functionality", () => {
  test("can generate an invitation link for a new member", async ({
    page,
    makeRandomString,
    goToPage,
  }) => {
    // Skip onboarding if dialog is present
    const skipButton = page.getByTestId(E2eTestId.OnboardingSkipButton);
    if (await skipButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipButton.click();
      await page.waitForTimeout(500);
    }

    // Navigate to the members settings page
    await goToPage(page, "/settings/members");

    // Wait for the page to load
    await page.waitForTimeout(1000);

    // Click the "Invite Member" button to open the dialog
    // The button is rendered by the OrganizationMembersCard from better-auth-ui
    await page.getByRole("button", { name: /invite member/i }).click();

    // Wait for the dialog to open
    await page.waitForTimeout(500);

    // Generate a random email for testing
    const TEST_EMAIL = `${makeRandomString(10, "test")}@example.com`;

    // Fill in the email input
    const emailInput = page.getByTestId(E2eTestId.InviteEmailInput);
    await expect(emailInput).toBeVisible();
    await emailInput.fill(TEST_EMAIL);

    // Select the role (default is "member", but we'll verify the select is visible)
    const roleSelect = page.getByTestId(E2eTestId.InviteRoleSelect);
    await expect(roleSelect).toBeVisible();

    // Click the "Generate Invitation Link" button
    const generateButton = page.getByTestId(
      E2eTestId.GenerateInvitationButton,
    );
    await expect(generateButton).toBeVisible();
    await expect(generateButton).toBeEnabled();
    await generateButton.click();

    // Wait for the invitation link to be generated
    // The component switches to show the invitation link input
    const invitationLinkInput = page.getByTestId(E2eTestId.InvitationLinkInput);
    await expect(invitationLinkInput).toBeVisible({ timeout: 5000 });

    // Verify the invitation link is not empty
    const linkValue = await invitationLinkInput.inputValue();
    expect(linkValue).toBeTruthy();
    expect(linkValue).toContain("/auth/sign-up-with-invitation");
    expect(linkValue).toContain("invitationId=");
    expect(linkValue).toContain(`email=${encodeURIComponent(TEST_EMAIL)}`);

    // Verify the copy button is visible
    const copyButton = page.getByTestId(E2eTestId.InvitationLinkCopyButton);
    await expect(copyButton).toBeVisible();
  });

  test("shows error message when email is invalid", async ({
    page,
    goToPage,
  }) => {
    // Skip onboarding if dialog is present
    const skipButton = page.getByTestId(E2eTestId.OnboardingSkipButton);
    if (await skipButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipButton.click();
      await page.waitForTimeout(500);
    }

    // Navigate to the members settings page
    await goToPage(page, "/settings/members");

    // Wait for the page to load
    await page.waitForTimeout(1000);

    // Click the "Invite Member" button to open the dialog
    await page.getByRole("button", { name: /invite member/i }).click();

    // Wait for the dialog to open
    await page.waitForTimeout(500);

    // Fill in an invalid email
    const emailInput = page.getByTestId(E2eTestId.InviteEmailInput);
    await expect(emailInput).toBeVisible();
    await emailInput.fill("invalid-email");

    // The "Generate Invitation Link" button should be disabled for invalid email
    const generateButton = page.getByTestId(
      E2eTestId.GenerateInvitationButton,
    );
    await expect(generateButton).toBeVisible();
    await expect(generateButton).toBeDisabled();
  });

  test("handles server error gracefully", async ({
    page,
    makeRandomString,
    goToPage,
  }) => {
    // Skip onboarding if dialog is present
    const skipButton = page.getByTestId(E2eTestId.OnboardingSkipButton);
    if (await skipButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipButton.click();
      await page.waitForTimeout(500);
    }

    // Navigate to the members settings page
    await goToPage(page, "/settings/members");

    // Wait for the page to load
    await page.waitForTimeout(1000);

    // Click the "Invite Member" button to open the dialog
    await page.getByRole("button", { name: /invite member/i }).click();

    // Wait for the dialog to open
    await page.waitForTimeout(500);

    // Intercept the API call and force it to fail
    await page.route("**/api/auth/organization/invite/member", (route) => {
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Internal Server Error",
          message: "Failed to generate invitation link",
        }),
      });
    });

    // Generate a random email for testing
    const TEST_EMAIL = `${makeRandomString(10, "test")}@example.com`;

    // Fill in the email input
    const emailInput = page.getByTestId(E2eTestId.InviteEmailInput);
    await expect(emailInput).toBeVisible();
    await emailInput.fill(TEST_EMAIL);

    // Click the "Generate Invitation Link" button
    const generateButton = page.getByTestId(
      E2eTestId.GenerateInvitationButton,
    );
    await expect(generateButton).toBeVisible();
    await expect(generateButton).toBeEnabled();
    await generateButton.click();

    // Wait for error message to appear (either in a toast or error boundary)
    // The component shows an error boundary when the API fails
    const errorMessage = page.getByTestId(E2eTestId.InvitationErrorMessage);
    await expect(errorMessage).toBeVisible({ timeout: 5000 });

    // Verify error message contains useful information
    const errorText = await errorMessage.textContent();
    expect(errorText).toBeTruthy();
  });
});

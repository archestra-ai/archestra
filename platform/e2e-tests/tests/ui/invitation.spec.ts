import { E2eTestId } from "@shared";
import { expect, test } from "../../fixtures";
import { clickButton } from "../../utils";

test.describe(
  "Invitation functionality",
  { tag: ["@firefox", "@webkit"] },
  () => {
    // increase stability
    test.describe.configure({ mode: "serial", retries: 4 });

    test("shows error message when email is invalid", async ({
      page,
      goToPage,
    }) => {
      // Navigate to the members settings page
      await goToPage(page, "/settings/members");

      // Wait for the page to load
      await page.waitForTimeout(1000);

      // Click the "Invite Member" button to open the dialog
      await clickButton({ page, options: { name: /invite member/i } });

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

    test("can generate invitation link and successfully sign up with it", async ({
      page,
      makeRandomString,
      goToPage,
      browser,
    }) => {
      // Generate a random email for testing
      const TEST_EMAIL = `${makeRandomString(10, "test")}@example.com`;
      const TEST_PASSWORD = "TestPassword123!";

      // PART 1: Generate the invitation link (as admin)
      // Navigate to the members settings page
      await goToPage(page, "/settings/members");

      // Wait for the page to load
      await page.waitForTimeout(1000);

      // Click the "Invite Member" button to open the dialog
      await clickButton({ page, options: { name: /invite member/i } });

      // Wait for the dialog to open
      await page.waitForTimeout(500);

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

      // Wait for the invitation link to be generated
      const invitationLinkInput = page.getByTestId(
        E2eTestId.InvitationLinkInput,
      );
      await expect(invitationLinkInput).toBeVisible({ timeout: 5000 });

      // Get the invitation link
      const invitationLink = await invitationLinkInput.inputValue();
      expect(invitationLink).toBeTruthy();
      expect(invitationLink).toContain("/auth/sign-up-with-invitation");

      // PART 2: Use the invitation link to sign up (as new user in incognito context)
      // Create a new incognito context to simulate a new user (no shared storage)
      const newUserContext = await browser.newContext({
        // Ensure no storage state is shared
        storageState: undefined,
      });

      const newUserPage = await newUserContext.newPage();

      try {
        // Navigate to the invitation link
        await newUserPage.goto(invitationLink);

        // Wait for the sign-up page to load
        await newUserPage.waitForTimeout(2000);

        // Verify we're on the invitation sign-up page
        await expect(
          newUserPage.getByText(
            "You've been invited to join Archestra workspace",
          ),
        ).toBeVisible();
        await expect(
          newUserPage.getByText(`Email: ${TEST_EMAIL}`),
        ).toBeVisible();

        // Fill in the sign-up form
        // The email should be pre-filled, but we need to fill in name and password
        const nameInput = newUserPage.getByRole("textbox", { name: /name/i });
        await expect(nameInput).toBeVisible();
        const uniqueName = `Test User ${makeRandomString(5)}`;
        await nameInput.fill(uniqueName);

        // Email should be pre-filled, but let's verify it's there
        const emailInputSignup = newUserPage.getByRole("textbox", {
          name: /email/i,
        });
        await expect(emailInputSignup).toBeVisible();
        const prefilledEmail = await emailInputSignup.inputValue();
        expect(prefilledEmail).toBe(TEST_EMAIL);

        // Fill in password
        const passwordInput = newUserPage.getByRole("textbox", {
          name: /password/i,
        });
        await expect(passwordInput).toBeVisible();
        await passwordInput.fill(TEST_PASSWORD);

        // Submit the form
        const signUpButton = newUserPage.getByRole("button", {
          name: /create an account/i,
        });
        await expect(signUpButton).toBeVisible();
        await signUpButton.click();

        // Wait for sign-up to complete and redirect
        // The page should redirect to the main app after successful sign-up
        await newUserPage.waitForURL(/\/$/, { timeout: 10000 });

        // Verify we're successfully logged in by checking for user elements
        // Look for the user button/menu that should appear when authenticated
        await expect(
          newUserPage.getByRole("button", {
            name: new RegExp(uniqueName, "i"),
          }),
        ).toBeVisible({
          timeout: 10000,
        });

        // PART 3: Verify the new user is listed in members (back to admin context)
        // Go back to the admin page and verify the new member appears
        await goToPage(page, "/settings/members");
        await page.waitForTimeout(1000);

        // Look for the new user in the members list
        await expect(page.getByText(TEST_EMAIL)).toBeVisible({ timeout: 5000 });
        await expect(page.getByText(uniqueName)).toBeVisible();
      } finally {
        // Clean up the new user context
        await newUserContext.close();
      }
    });
  },
);

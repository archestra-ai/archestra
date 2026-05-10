import { E2eTestId } from "@shared";
import { ADMIN_EMAIL, ADMIN_PASSWORD, UI_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";
import { clickButton, navigateAndVerifyAuth } from "../utils";

test.describe("User soft-delete blocks re-authentication", {
  tag: ["@firefox", "@webkit"],
}, () => {
  test.describe.configure({ retries: 2, timeout: 180_000 });

  test("a removed user cannot sign in with their original credentials", async ({
    page,
    makeRandomString,
    goToPage,
    browser,
  }) => {
    const TEST_EMAIL = `${makeRandomString(10, "deleted")}@example.com`;
    const TEST_PASSWORD = "TestPassword123!";

    // PART 1 — admin generates an invitation link
    const inviteButton = page.getByRole("button", { name: /invite user/i });
    await navigateAndVerifyAuth({
      page,
      path: "/settings/users",
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      verifyLocator: inviteButton,
      goToPage,
    });

    await clickButton({ page, options: { name: /invite user/i } });
    const emailInput = page.getByTestId(E2eTestId.InviteEmailInput);
    await expect(emailInput).toBeVisible();
    await emailInput.fill(TEST_EMAIL);

    const generateButton = page.getByTestId(E2eTestId.GenerateInvitationButton);
    await expect(generateButton).toBeEnabled();
    await generateButton.click();

    const invitationLinkInput = page.getByTestId(E2eTestId.InvitationLinkInput);
    await expect(invitationLinkInput).toBeVisible({ timeout: 30_000 });
    const invitationLink = await invitationLinkInput.inputValue();
    expect(invitationLink).toContain("/auth/sign-up-with-invitation");

    // PART 2 — new user signs up via the invitation link in an incognito
    // context so the admin's session in `page` stays untouched
    const newUserContext = await browser.newContext({ storageState: undefined });
    const newUserPage = await newUserContext.newPage();
    try {
      await newUserPage.goto(invitationLink);
      await expect(
        newUserPage.getByText(/You've been invited to join the .* workspace/i),
      ).toBeVisible({ timeout: 15_000 });

      await newUserPage
        .getByRole("textbox", { name: /name/i })
        .fill(`Deleted User ${makeRandomString(5)}`);
      await newUserPage
        .getByRole("textbox", { name: /password/i })
        .fill(TEST_PASSWORD);
      await newUserPage
        .getByRole("button", { name: /create an account/i })
        .click();

      await newUserPage.waitForURL(/\/(chat)?$/, { timeout: 30_000 });
    } finally {
      await newUserContext.close();
    }

    // PART 3 — admin removes the member, which (when no other memberships
    // remain) routes through UserModel.delete and tombstones the user
    const membersResponse = await page.request.get(
      `${UI_BASE_URL}/api/organization/members`,
      { headers: { Origin: UI_BASE_URL } },
    );
    expect(membersResponse.ok()).toBe(true);
    const members = (await membersResponse.json()) as Array<{
      id: string;
      email: string;
    }>;
    const target = members.find((m) => m.email === TEST_EMAIL);
    expect(target, `member ${TEST_EMAIL} should be in org members`).toBeDefined();

    const sessionResponse = await page.request.get(
      `${UI_BASE_URL}/api/auth/get-session`,
      { headers: { Origin: UI_BASE_URL } },
    );
    const sessionBody = await sessionResponse.json();
    const organizationId = sessionBody?.session?.activeOrganizationId;
    expect(organizationId).toBeTruthy();

    const removeResponse = await page.request.post(
      `${UI_BASE_URL}/api/auth/organization/remove-member`,
      {
        headers: {
          "Content-Type": "application/json",
          Origin: UI_BASE_URL,
        },
        data: {
          memberIdOrEmail: target!.id,
          organizationId,
        },
      },
    );
    expect(removeResponse.ok()).toBe(true);

    // PART 4 — the soft-delete invariant: the credentials that worked a
    // moment ago must now fail. Use a fresh request context so no cached
    // session is reused.
    const freshContext = await browser.newContext({ storageState: undefined });
    try {
      const signInResponse = await freshContext.request.post(
        `${UI_BASE_URL}/api/auth/sign-in/email`,
        {
          headers: {
            "Content-Type": "application/json",
            Origin: UI_BASE_URL,
          },
          data: { email: TEST_EMAIL, password: TEST_PASSWORD },
          // Better-auth returns 401/403 on bad credentials and Playwright
          // would otherwise treat any non-2xx as a thrown error.
          failOnStatusCode: false,
        },
      );
      expect(signInResponse.ok()).toBe(false);
      expect([401, 403, 404]).toContain(signInResponse.status());
    } finally {
      await freshContext.close();
    }
  });
});

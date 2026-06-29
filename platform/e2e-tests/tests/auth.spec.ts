import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  E2eTestId,
  EDITOR_EMAIL,
  EDITOR_PASSWORD,
  MEMBER_EMAIL,
  MEMBER_PASSWORD,
} from "../consts";
import { expect, test } from "../fixtures";
import { expandSidebar, navigateAndVerifyAuth } from "../utils";

test.describe("Multi-user authentication", {
  tag: ["@firefox", "@webkit"],
}, () => {
  // Extended timeout for WebKit/Firefox CI where React hydration is slow
  // 3 sequential user verifications × 45s each = up to 135s needed
  test.describe.configure({ retries: 2, timeout: 180_000 });

  test("each user sees their own email in the sidebar", async ({
    adminPage,
    editorPage,
    memberPage,
    goToPage,
  }) => {
    // Use polling with page reload to handle slow React hydration in Firefox/WebKit CI
    const verifyEmailInSidebar = async (
      page: Parameters<typeof navigateAndVerifyAuth>[0]["page"],
      email: string,
      password: string,
    ) => {
      await navigateAndVerifyAuth({
        page,
        path: "/chat",
        email,
        password,
        goToPage,
        timeout: 60_000,
        intervals: [2000, 5000, 10000],
        verifyLocator: page.getByTestId(E2eTestId.SidebarUserProfile),
      });
      await expandSidebar(page);
      await expect(
        page.getByTestId(E2eTestId.SidebarUserProfile).getByText(email),
      ).toBeVisible({ timeout: 15_000 });
    };

    await verifyEmailInSidebar(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
    await verifyEmailInSidebar(editorPage, EDITOR_EMAIL, EDITOR_PASSWORD);
    await verifyEmailInSidebar(memberPage, MEMBER_EMAIL, MEMBER_PASSWORD);
  });
});

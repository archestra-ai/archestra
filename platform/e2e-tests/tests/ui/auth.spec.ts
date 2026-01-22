import {
  ADMIN_EMAIL,
  E2eTestId,
  EDITOR_EMAIL,
  MEMBER_EMAIL,
} from "../../consts";
import { expect, test } from "../../fixtures";

test.describe(
  "Multi-user authentication",
  { tag: ["@firefox", "@webkit"] },
  () => {
    test("each user sees their own email in the sidebar", async ({
      adminPage,
      editorPage,
      memberPage,
      goToPage,
    }) => {
      // Navigate all pages to the app
      await Promise.all([
        goToPage(adminPage, "/chat"),
        goToPage(editorPage, "/chat"),
        goToPage(memberPage, "/chat"),
      ]);

      // Wait for pages to fully load (React hydration and API calls)
      // Firefox/WebKit may need extra time in CI environments
      await Promise.all([
        adminPage.waitForLoadState("networkidle"),
        editorPage.waitForLoadState("networkidle"),
        memberPage.waitForLoadState("networkidle"),
      ]);

      // Verify admin sees admin email with extended timeout for CI stability
      await expect(
        adminPage
          .getByTestId(E2eTestId.SidebarUserProfile)
          .getByText(ADMIN_EMAIL),
      ).toBeVisible({ timeout: 15_000 });

      // Verify editor sees editor email
      await expect(
        editorPage
          .getByTestId(E2eTestId.SidebarUserProfile)
          .getByText(EDITOR_EMAIL),
      ).toBeVisible({ timeout: 15_000 });

      // Verify member sees member email
      await expect(
        memberPage
          .getByTestId(E2eTestId.SidebarUserProfile)
          .getByText(MEMBER_EMAIL),
      ).toBeVisible({ timeout: 15_000 });
    });
  },
);

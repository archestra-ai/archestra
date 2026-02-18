import type { Page } from "@playwright/test";
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
      // Use polling with page reload to handle slow React hydration in Firefox/WebKit CI
      const verifyEmailInSidebar = async (page: Page, email: string) => {
        await expect(async () => {
          await goToPage(page, "/chat");
          await page.waitForLoadState("domcontentloaded");
          await expect(
            page.getByTestId(E2eTestId.SidebarUserProfile).getByText(email),
          ).toBeVisible({ timeout: 10_000 });
        }).toPass({ timeout: 30_000, intervals: [2000, 5000, 10000] });
      };

      await verifyEmailInSidebar(adminPage, ADMIN_EMAIL);
      await verifyEmailInSidebar(editorPage, EDITOR_EMAIL);
      await verifyEmailInSidebar(memberPage, MEMBER_EMAIL);
    });
  },
);

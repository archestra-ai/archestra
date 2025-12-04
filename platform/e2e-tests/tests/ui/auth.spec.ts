import { ADMIN_EMAIL, EDITOR_EMAIL, MEMBER_EMAIL } from "../../consts";
import { expect, test } from "../../fixtures";

test.describe("Multi-user authentication", () => {
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

    // Verify admin sees admin email
    await expect(adminPage.getByText(ADMIN_EMAIL)).toBeVisible();

    // Verify editor sees editor email
    await expect(editorPage.getByText(EDITOR_EMAIL)).toBeVisible();

    // Verify member sees member email
    await expect(memberPage.getByText(MEMBER_EMAIL)).toBeVisible();
  });
});

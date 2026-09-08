import { E2eTestId } from "@archestra/shared";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "../consts";
import { expect, test } from "../fixtures";
import { navigateAndVerifyAuth } from "../utils";

/** Exercise reopening, switching, and clearing the searchable role filter. */
test.describe("Users settings role filter", () => {
  test.beforeEach(async ({ page, goToPage }) => {
    await navigateAndVerifyAuth({
      page,
      path: "/settings/users",
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      verifyLocator: page.getByTestId(E2eTestId.UsersRoleFilter),
      goToPage,
    });
  });

  test("stays usable across repeated filtering", async ({ page }) => {
    const filter = page.getByTestId(E2eTestId.UsersRoleFilter);

    // First selection — this much always worked.
    await filter.click();
    await page.getByRole("button", { name: /^Admin\b/ }).click();
    await expect(page).toHaveURL(/role=admin/);
    await expect(filter).toContainText(/admin/i);

    // Reopening after a selection is the actual regression: the list must be
    // on-screen and its options clickable, not merely present in the DOM.
    await filter.click();
    await page.getByRole("button", { name: /^Member\b/ }).click();
    await expect(page).toHaveURL(/role=member/);
    await expect(filter).toContainText(/member/i);

    // And clearing the filter must work from that state too.
    await filter.click();
    await page.getByRole("button", { name: "All roles", exact: true }).click();
    await expect(page).not.toHaveURL(/role=/);

    // A dropdown that never finished closing strands `pointer-events: none` on
    // <body>, which disables the whole page rather than just the filter.
    await expect
      .poll(() =>
        page.evaluate(() => document.body.style.pointerEvents || "unset"),
      )
      .toBe("unset");
  });

  test("opens when the page loads already filtered", async ({
    page,
    goToPage,
  }) => {
    // A direct load of a filtered URL renders the trigger in its selected
    // state without any navigation, which was broken on the very first open.
    await goToPage(page, "/settings/users?role=admin&page=1");

    const filter = page.getByTestId(E2eTestId.UsersRoleFilter);
    await expect(filter).toContainText(/admin/i);

    await filter.click();
    await page.getByRole("button", { name: /^Editor\b/ }).click();
    await expect(page).toHaveURL(/role=editor/);
  });
});

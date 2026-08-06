import { E2eTestId } from "@archestra/shared";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "../consts";
import { expect, test } from "../fixtures";
import { navigateAndVerifyAuth } from "../utils";

/**
 * The role filter is a Radix Select with a custom trigger label. Radix only
 * positions an item-aligned dropdown once it can see every part it needs —
 * including the value node — so a trigger that stops rendering SelectValue
 * after a selection leaves the list unpositioned off-screen with
 * `pointer-events: none` still on <body>, which reads to a user as a filter
 * that opens once and then goes dead.
 *
 * These tests drive real clicks, so an off-screen list fails them on
 * actionability rather than needing a positioning assertion.
 */
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
    await page.getByRole("option", { name: "Admin", exact: true }).click();
    await expect(page).toHaveURL(/role=admin/);
    await expect(filter).toContainText(/admin/i);

    // Reopening after a selection is the actual regression: the list must be
    // on-screen and its options clickable, not merely present in the DOM.
    await filter.click();
    await page.getByRole("option", { name: "Member", exact: true }).click();
    await expect(page).toHaveURL(/role=member/);
    await expect(filter).toContainText(/member/i);

    // And clearing the filter must work from that state too.
    await filter.click();
    await page.getByRole("option", { name: "All Roles", exact: true }).click();
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
    await page.getByRole("option", { name: "Editor", exact: true }).click();
    await expect(page).toHaveURL(/role=editor/);
  });
});

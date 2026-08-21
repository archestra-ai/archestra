import { shareableSkillsSeed } from "../src/mocks/data/skill-share";
import { expect, test } from "./fixtures";

/**
 * The bulk affordance every table shares: no chrome until rows are ticked,
 * then a count, a Clear, and the page's own actions. Driven through Skills
 * because it is the table whose actions are plain buttons; the guardrails and
 * knowledge tables render the same `BulkActionsBar` with different children.
 */
test.describe("Bulk actions bar", () => {
  test.beforeEach(async ({ mswControl }) => {
    // The base skills seed is empty, which renders the "no skills" state and
    // leaves no row to tick.
    await mswControl.use({
      method: "get",
      url: "/api/skills",
      body: shareableSkillsSeed,
    });
  });

  test("stays out of the page until a row is ticked, and clears back away", async ({
    page,
  }) => {
    await page.goto("/skills");

    const count = page.getByTestId("skills-bulk-selection-count");
    const clear = page.getByRole("button", { name: "Clear" });
    await expect(
      page.getByRole("checkbox", { name: "Select all skills on this page" }),
    ).toBeVisible();
    await expect(count).toBeHidden();
    await expect(clear).toBeHidden();

    const [firstRow, secondRow] = [
      page.getByRole("checkbox", {
        name: `Select ${shareableSkillsSeed.data[0].name}`,
      }),
      page.getByRole("checkbox", {
        name: `Select ${shareableSkillsSeed.data[1].name}`,
      }),
    ];

    await firstRow.click();
    await expect(count).toHaveText("1 skill selected");

    await secondRow.click();
    await expect(count).toHaveText("2 skills selected");
    await expect(
      page.getByRole("button", { name: "Edit visibility" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Delete", exact: true }),
    ).toBeVisible();

    await clear.click();
    await expect(count).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Edit visibility" }),
    ).toBeHidden();
  });

  test("offers the whole matching set once the page is exhausted", async ({
    page,
    mswControl,
  }) => {
    // A page that holds less than what matches, which is the only situation
    // where reaching past the page means anything.
    await mswControl.use({
      method: "get",
      url: "/api/skills",
      body: {
        ...shareableSkillsSeed,
        pagination: {
          ...shareableSkillsSeed.pagination,
          limit: 2,
          total: 7,
          totalPages: 4,
          hasNext: true,
        },
      },
    });
    await page.goto("/skills");

    await page
      .getByRole("checkbox", { name: "Select all skills on this page" })
      .click();

    const offer = page.getByRole("button", { name: /^Select all/ });
    await expect(offer).toHaveText(
      "Select all 7 skills that match the current filters.",
    );

    await offer.click();

    await expect(page.getByTestId("skills-bulk-selection-count")).toHaveText(
      "All 7 skills selected",
    );
    // The offer has nothing left to escalate to.
    await expect(offer).toBeHidden();
  });

  test("ticking a row selects it instead of opening the row's editor", async ({
    page,
  }) => {
    await page.goto("/skills");

    await page
      .getByRole("checkbox", {
        name: `Select ${shareableSkillsSeed.data[0].name}`,
      })
      .click();

    await expect(page.getByTestId("skills-bulk-selection-count")).toHaveText(
      "1 skill selected",
    );
    await expect(page).toHaveURL(/\/skills(\?.*)?$/);
  });
});

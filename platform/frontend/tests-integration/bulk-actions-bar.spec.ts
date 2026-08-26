import type { Locator, Page } from "@playwright/test";
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

  test("adds the rail and its gap only once something is selected", async ({
    page,
  }) => {
    await page.goto("/skills");

    const bar = page.locator('[data-slot="bulk-actions-bar"]');
    const firstRow = page.getByRole("checkbox", {
      name: `Select ${shareableSkillsSeed.data[0].name}`,
    });
    // Measure only once the collection is on the page: until then the list
    // renders a loading placeholder and there is nothing below the bar to
    // measure against.
    await firstRow.waitFor();

    // Nothing selected: no bar, and therefore no empty rail above the
    // collection. This is the whole point of the element being absent.
    await expect(bar).toHaveCount(0);
    const collectionTopBefore = await collectionTop(page);

    await firstRow.click();

    const afterSelection = await bulkLayoutGeometry(bar);
    expect(afterSelection).toMatchObject({
      height: 42,
      gapAbove: 12,
      gapBelow: 12,
    });
    // The collection moves down by exactly the rail it made room for, so the
    // rail is never overlapping or double-spaced.
    expect(afterSelection.collectionTop - collectionTopBefore).toBe(42 + 12);
  });

  test("scrolls crowded actions inside the fixed mobile rail", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/skills");
    await page
      .getByRole("checkbox", {
        name: `Select ${shareableSkillsSeed.data[0].name}`,
      })
      .click();

    const metrics = await page
      .locator('[data-slot="bulk-actions-bar"]')
      .evaluate((bar) => {
        const rail = bar.firstElementChild as HTMLElement;
        return {
          height: bar.getBoundingClientRect().height,
          overflowX: getComputedStyle(rail).overflowX,
          clientWidth: rail.clientWidth,
          scrollWidth: rail.scrollWidth,
          bodyOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        };
      });

    expect(metrics).toMatchObject({
      height: 42,
      overflowX: "auto",
      bodyOverflow: 0,
    });
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
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

async function bulkLayoutGeometry(bar: Locator): Promise<{
  height: number;
  gapAbove: number;
  gapBelow: number;
  collectionTop: number;
}> {
  return bar.evaluate((element) => {
    let branch = element as HTMLElement | null;
    let previous: HTMLElement | null = null;
    while (branch && !previous) {
      previous = branch.previousElementSibling as HTMLElement | null;
      while (previous?.classList.contains("sr-only")) {
        previous = previous.previousElementSibling as HTMLElement | null;
      }
      branch = branch.parentElement;
    }
    const collection = element.nextElementSibling as HTMLElement;
    const barRect = element.getBoundingClientRect();

    return {
      height: barRect.height,
      gapAbove: barRect.top - (previous?.getBoundingClientRect().bottom ?? 0),
      gapBelow: collection.getBoundingClientRect().top - barRect.bottom,
      collectionTop: collection.getBoundingClientRect().top,
    };
  });
}

/**
 * Top of the collection when no bar is mounted. `bulkLayoutGeometry` walks
 * out from the bar itself, which does not exist at zero selection, so this
 * anchors on the live region the bar always renders beside instead.
 */
async function collectionTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    // Same upward walk `bulkLayoutGeometry` does from the bar: the live region
    // and the collection are siblings on some pages and separated by a wrapper
    // on others, so climb until there is a following element to measure.
    let branch = document.querySelector(
      'span[aria-live="polite"].sr-only',
    ) as HTMLElement | null;
    let next: HTMLElement | null = null;
    while (branch && !next) {
      next = branch.nextElementSibling as HTMLElement | null;
      while (next?.classList.contains("sr-only")) {
        next = next.nextElementSibling as HTMLElement | null;
      }
      branch = branch.parentElement;
    }
    if (!next) throw new Error("no collection after the bulk live region");
    return next.getBoundingClientRect().top;
  });
}

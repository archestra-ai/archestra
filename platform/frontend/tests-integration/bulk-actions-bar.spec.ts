import type { Locator } from "@playwright/test";
import { shareableSkillsSeed } from "../src/mocks/data/skill-share";
import { expect, test } from "./fixtures";

/**
 * The bulk affordance every table shares: an in-flow reserved rail, then a
 * count, a Clear, and the page's own actions after rows are ticked. Driven through Skills
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

  test("shows a zero count until a row is ticked, and clears back to zero", async ({
    page,
  }) => {
    await page.goto("/skills");

    const count = page.getByTestId("skills-bulk-selection-count");
    const clear = page.getByRole("button", { name: "Clear" });
    await expect(
      page.getByRole("checkbox", { name: "Select all skills on this page" }),
    ).toBeVisible();
    await expect(count).toHaveText("0 skills selected");
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
    await expect(count).toHaveText("0 skills selected");
    await expect(
      page.getByRole("button", { name: "Edit visibility" }),
    ).toBeHidden();
  });

  test("reserves a stable in-flow rail before and after selection", async ({
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

    await expect(bar).toBeVisible();
    const beforeSelection = await bulkLayoutGeometry(bar);
    expect(beforeSelection).toMatchObject({
      height: 42,
      gapBelow: 12,
    });
    await firstRow.click();

    const afterSelection = await bulkLayoutGeometry(bar);
    expect(afterSelection).toMatchObject({
      height: 42,
      gapBelow: 12,
    });
    // Reserving the rail prevents table/card layout from jumping on selection.
    expect(afterSelection.collectionTop).toBe(beforeSelection.collectionTop);
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
    const matchingSkills = Array.from({ length: 7 }, (_, index) => ({
      ...shareableSkillsSeed.data[index % shareableSkillsSeed.data.length],
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `skill-${index + 1}`,
    }));
    await mswControl.use({
      method: "get",
      url: "/api/skills",
      body: {
        ...shareableSkillsSeed,
        data: matchingSkills,
        pagination: {
          ...shareableSkillsSeed.pagination,
          limit: 100,
          total: 7,
          totalPages: 1,
          hasNext: false,
        },
      },
    });
    // The collection loads all sources once, then applies its shared page size.
    await page.goto("/skills?pageSize=2");

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
  gapBelow: number;
  collectionTop: number;
}> {
  return bar.evaluate((element) => {
    let collectionBranch = element as HTMLElement | null;
    let collection: HTMLElement | null = null;
    while (collectionBranch && !collection) {
      collection = collectionBranch.nextElementSibling as HTMLElement | null;
      while (collection?.classList.contains("sr-only")) {
        collection = collection.nextElementSibling as HTMLElement | null;
      }
      collectionBranch = collectionBranch.parentElement;
    }
    if (!collection)
      throw new Error("no collection after the bulk actions bar");
    const barRect = element.getBoundingClientRect();

    return {
      height: barRect.height,
      gapBelow: collection.getBoundingClientRect().top - barRect.bottom,
      collectionTop: collection.getBoundingClientRect().top,
    };
  });
}

import { expect, test } from "./fixtures";

/**
 * A list page's filter bar packs a search box, the scope/label selects and a
 * status select onto one row. The row did not wrap, and the selects hold fixed
 * widths, so at a phone width the search box absorbed the whole shortfall and
 * collapsed to its magnifier — still focusable, and the keyboard still opened,
 * but with no room left to show or edit what had been typed. The filters past
 * it were clipped off the side of the screen at the same time.
 *
 * These assert the geometry rather than the styling: a class-name check would
 * have passed throughout the bug, because the classes were reasonable and only
 * the arithmetic was wrong.
 */

// A Pixel-class phone, which is the width the bug was reported from.
test.use({ viewport: { width: 360, height: 740 } });

/** Reads the search box and its filter row straight out of the layout. */
async function measureFilterBar(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLElement>(
      'input[placeholder^="Search"]',
    );
    if (!input) throw new Error("no search box on the page");

    // The filter row is the nearest flex ancestor holding more than the search
    // box alone — i.e. the row the search box shares with the filters.
    let row: HTMLElement | null = null;
    for (let el = input.parentElement; el; el = el.parentElement) {
      if (getComputedStyle(el).display === "flex" && el.children.length > 1) {
        row = el;
        break;
      }
    }
    if (!row) throw new Error("search box is not in a filter row");

    const rowRect = row.getBoundingClientRect();
    const clipped: string[] = [];
    for (const child of Array.from(row.children)) {
      const r = child.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (Math.round(r.right - rowRect.right) > 0) {
        clipped.push((child.textContent ?? "").replace(/\s+/g, " ").trim());
      }
    }

    return {
      searchWidth: input.getBoundingClientRect().width,
      rowWidth: rowRect.width,
      clipped,
    };
  });
}

test.describe("List filter bar at a phone width", () => {
  test("the search box keeps room to show what was typed", async ({
    agentsPage,
    page,
  }) => {
    await agentsPage.goto();
    await expect(agentsPage.heading).toBeVisible();
    await expect(page.locator('input[placeholder^="Search"]')).toBeVisible();

    const { searchWidth, rowWidth } = await measureFilterBar(page);

    // Collapsed, the box was the magnifier and its padding — about a sixth of
    // the row. Filling its own line, it is the whole row. Half is far outside
    // either case, so this pins the behaviour without pinning the layout.
    expect(searchWidth).toBeGreaterThan(rowWidth / 2);
  });

  test("no filter is clipped off the side of the row", async ({
    agentsPage,
    page,
  }) => {
    await agentsPage.goto();
    await expect(agentsPage.heading).toBeVisible();
    await expect(page.locator('input[placeholder^="Search"]')).toBeVisible();

    const { clipped } = await measureFilterBar(page);

    expect(clipped).toEqual([]);
  });
});

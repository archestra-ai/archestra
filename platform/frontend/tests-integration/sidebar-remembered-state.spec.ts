import { expect, test } from "./fixtures";

/**
 * The sidebar starts open; once someone collapses or opens it, their choice
 * holds on every later visit in that browser.
 */
test("the sidebar remembers the person's last choice", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sidebar = page.locator('[data-slot="sidebar"]');
  const toggle = page.locator('[data-slot="sidebar-circle-toggle"]');

  await page.goto("/agents");
  await expect(sidebar).toHaveAttribute("data-state", "expanded");

  await toggle.click({ force: true });
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");

  await toggle.click({ force: true });
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
});

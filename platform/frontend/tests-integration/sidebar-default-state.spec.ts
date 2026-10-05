import { organizationSeed } from "@/mocks/data/organization";
import { expect, test } from "./fixtures";

/**
 * The organization decides whether the sidebar starts collapsed (Appearance →
 * Layout); once someone opens or collapses it themselves, their choice wins
 * on every later visit in that browser.
 */
test("the organization default applies until the person toggles the sidebar", async ({
  page,
  mswControl,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mswControl.use({
    method: "get",
    url: "/api/organization",
    body: { ...organizationSeed, collapseSidebarByDefault: true },
  });
  const sidebar = page.locator('[data-slot="sidebar"]');

  await page.goto("/agents");
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");

  await page
    .locator('[data-slot="sidebar-circle-toggle"]')
    .click({ force: true });
  await expect(sidebar).toHaveAttribute("data-state", "expanded");

  await page.reload();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
});

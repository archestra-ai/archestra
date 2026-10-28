import { expect, test } from "./fixtures";

for (const theme of ["light", "dark"]) {
  test(`onboarding dots stay inside collapsed icons and clear on visit (${theme})`, async ({
    page,
    mswControl,
  }) => {
    await page.addInitScript(
      (theme) => localStorage.setItem("theme", theme),
      theme,
    );
    await mswControl.use({
      method: "get",
      url: "/api/onboarding/seen-nav-items",
      body: { items: [] },
    });
    await page.goto("/chat");
    const projects = page.getByRole("link", { name: /Projects/ });
    const dot = projects.getByTestId("onboarding-dot");
    await expect(dot).toBeVisible();
    await expect(projects).toHaveAccessibleName(/new items available/);
    const row = await projects.boundingBox();
    const expanded = await dot.boundingBox();
    if (!row || !expanded) throw new Error("Missing sidebar geometry");
    await expect
      .poll(async () => (await dot.boundingBox())?.width)
      .toBeCloseTo(6, 0);
    expect(expanded.y + expanded.height / 2).toBeCloseTo(
      row.y + row.height / 2,
      0,
    );

    await page
      .getByRole("button", { name: "Collapse sidebar", exact: true })
      .click({ force: true });
    await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
      "data-state",
      "collapsed",
    );
    await expect(async () => {
      const iconRow = await projects.boundingBox();
      const collapsed = await dot.boundingBox();
      if (!iconRow || !collapsed) throw new Error("Missing collapsed geometry");
      // The 2px separation ring must fit inside the clickable row, above its
      // midpoint, instead of merging into the icon's middle-right edge.
      expect(collapsed.x + collapsed.width + 2).toBeLessThanOrEqual(
        iconRow.x + iconRow.width,
      );
      expect(collapsed.y - 2).toBeGreaterThanOrEqual(iconRow.y);
      expect(collapsed.y + collapsed.height).toBeLessThan(
        iconRow.y + iconRow.height / 2,
      );
    }).toPass();
    await mswControl.registerMany([
      {
        method: "post",
        url: "/api/onboarding/seen-nav-items",
        body: { items: ["nav:projects"] },
      },
      {
        method: "get",
        url: "/api/onboarding/seen-nav-items",
        body: { items: ["nav:projects"] },
      },
    ]);
    await test.info().attach(`collapsed-${theme}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await projects.click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(dot).toHaveCount(0);
    await expect(projects).not.toHaveAccessibleName(/new items available/);
  });
}

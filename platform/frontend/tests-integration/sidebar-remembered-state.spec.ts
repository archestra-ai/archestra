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
  expect(
    (await page.context().cookies()).find((c) => c.name === "sidebar_state")
      ?.value,
  ).toBe("false");
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");

  await toggle.click({ force: true });
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
});

for (const open of [false, true]) {
  test(`the ${open ? "expanded" : "collapsed"} preference holds from the first frame through reload and navigation`, async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("baseURL is required");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page
      .context()
      .addCookies([
        { name: "sidebar_state", value: String(open), url: baseURL },
      ]);
    await page.addInitScript((remembered) => {
      localStorage.setItem("archestra-sidebar-open", String(remembered));
      const frames: Array<{ state: string | null; width: number }> = [];
      Object.assign(window, { sidebarFrames: frames });
      const sample = () => {
        const sidebar = document.querySelector('[data-slot="sidebar"]');
        const gap = document.querySelector('[data-slot="sidebar-gap"]');
        if (sidebar && gap) {
          frames.push({
            state: sidebar.getAttribute("data-state"),
            width: gap.getBoundingClientRect().width,
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, open);

    const sidebar = page.locator('[data-slot="sidebar"]');
    const state = open ? "expanded" : "collapsed";
    const assertFrames = async () => {
      await expect(sidebar).toHaveAttribute("data-state", state);
      const frames = await page.evaluate(
        () =>
          (
            window as unknown as {
              sidebarFrames: Array<{ state: string; width: number }>;
            }
          ).sidebarFrames,
      );
      expect(frames.length).toBeGreaterThan(0);
      expect([...new Set(frames.map((frame) => frame.state))]).toEqual([state]);
      expect(
        Math.max(...frames.map((frame) => frame.width)) -
          Math.min(...frames.map((frame) => frame.width)),
      ).toBeLessThan(1);
    };

    await page.goto("/agents");
    await expect(
      page.getByRole("link", { name: "Skills", exact: true }),
    ).toBeVisible();
    await assertFrames();
    await page.reload();
    await expect(
      page.getByRole("link", { name: "Skills", exact: true }),
    ).toBeVisible();
    await assertFrames();
    await page.getByRole("link", { name: "Skills", exact: true }).click();
    await expect(page).toHaveURL(/\/skills$/);
    await assertFrames();
    await page.goBack();
    await expect(page).toHaveURL(/\/agents$/);
    await assertFrames();
  });
}

test("the mobile sheet does not overwrite the desktop preference", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("baseURL is required");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .context()
    .addCookies([{ name: "sidebar_state", value: "false", url: baseURL }]);
  await page.goto("/agents");
  const toggle = page.getByRole("button", {
    name: "Expand sidebar",
    exact: true,
  });
  await toggle.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    (await page.context().cookies()).find((c) => c.name === "sidebar_state")
      ?.value,
  ).toBe("false");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
    "data-state",
    "collapsed",
  );
});

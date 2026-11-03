import { expect } from "@playwright/test";
import { test } from "./fixtures";

for (const path of ["/llm/costs", "/llm/usage"]) {
  test(`clicking a bar on ${path} does not outline the plot and keeps keyboard tooltips`, async ({
    page,
  }) => {
    const group = path.endsWith("costs") ? "person" : "client";
    await page.goto(`${path}?timeframe=30d&group=${group}`, {
      waitUntil: "domcontentloaded",
    });
    const chart = page.locator('[data-slot="chart"]').first();
    await chart
      .locator(".recharts-bar-rectangle")
      .first()
      .click({ timeout: 60_000 });
    const focusedLayer = chart.locator('[tabindex="-1"]:focus');
    await expect(focusedLayer).toHaveCSS("outline-style", "none");
    await expect(chart.locator(".recharts-tooltip-wrapper")).toBeVisible();
    await chart.locator('svg[role="application"]').press("ArrowRight");
    await expect(chart.locator(".recharts-tooltip-wrapper")).toBeVisible();
  });

  test(`${path} highlights model series, drills down, and restores responsive chart preferences`, async ({
    page,
  }) => {
    await page.goto(`${path}?timeframe=30d&group=model&chart=bars`, {
      waitUntil: "domcontentloaded",
    });
    const chart = page.locator('[data-slot="chart"]').first();
    const segment = chart.locator(".recharts-bar-rectangle path").first();
    await segment.hover({ timeout: 60_000 });
    await expect(chart.locator('[aria-current="true"]')).toContainText(
      path.endsWith("costs") ? "claude-opus-4-7" : "Billed spend",
    );
    if (path.endsWith("costs"))
      await expect(
        chart.locator('.recharts-bar-rectangle path[opacity="0.2"]').first(),
      ).toBeVisible();
    await segment.click();
    await expect(
      page.getByRole("navigation", { name: "Model drill-down" }),
    ).toContainText("claude-opus-4-7");
    await expect(page).toHaveURL(/model=claude-opus-4-7/);
    await expect(page.getByRole("button", { name: /^split by / })).toHaveCount(
      0,
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("navigation", { name: "Model drill-down" }),
    ).toContainText("claude-opus-4-7");
    await page.getByRole("button", { name: "Clear model filter" }).click();
    await page.getByRole("button", { name: "Lines", exact: true }).click();
    await expect(page.locator(".recharts-line-curve").first()).toBeVisible();
    const line = page.locator(".recharts-line-curve").first();
    await chart.scrollIntoViewIfNeeded();
    const point = await line.evaluate((element) => {
      const path = element as SVGPathElement;
      const point = path.getPointAtLength(20);
      const transform = path.getScreenCTM();
      if (!transform) throw new Error("Line is not mounted");
      const screen = point.matrixTransform(transform);
      const box = path.closest('[data-slot="chart"]')?.getBoundingClientRect();
      if (!box) throw new Error("Chart container is not mounted");
      return { x: screen.x - box.x, y: screen.y - box.y };
    });
    // Target the HTML container so SVG bounding-box quirks cannot offset the pointer.
    await chart.hover({ position: point });
    const active = page.locator(
      '.recharts-tooltip-wrapper [aria-current="true"]',
    );
    await expect(active).toBeVisible();
    const stroke = await line.evaluate((el) => getComputedStyle(el).stroke);
    await expect(active.locator("span").first()).toHaveCSS(
      "background-color",
      stroke,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("button", { name: "Chart options" }),
    ).toBeVisible();
    await expect(page.locator('[data-slot="chart"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Chart options" }).click();
    await expect(
      page.getByRole("button", { name: "Table only", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("button", { name: "Stacked bars", exact: true })
      .click();
    await expect(page).toHaveURL(/mobileChart=bars/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".recharts-bar").first()).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(
      page.getByRole("button", { name: "Lines", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".recharts-line-curve").first()).toBeVisible();
  });
}

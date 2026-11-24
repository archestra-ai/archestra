import { costStatisticsFor } from "../src/mocks/data/statistics";
import { expect, test } from "./fixtures";

test.use({ viewport: { width: 1400, height: 700 } });

test("changing a Costs range preserves the scrolled page through loading and history", async ({
  page,
  mswControl,
}) => {
  const costs = costStatisticsFor(new URLSearchParams({ timeframe: "30d" }));
  await mswControl.use({
    method: "get",
    url: "/api/statistics/costs",
    body: costs,
    delayMs: 1200,
  });
  await page.goto("/llm/costs?timeframe=30d");
  const explorer = page.getByRole("region", { name: "Cost explorer" });
  await expect(explorer.getByRole("table")).toBeVisible();
  const scroller = page.locator("[data-page-scroll-container]");
  await scroller.evaluate((el) => {
    el.scrollTop = 650;
  });
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(650);

  const changeRange = async (label: string) => {
    await page
      .getByRole("button", { name: /^Last \d+ (days|hours?)$/ })
      .click();
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(explorer.getByRole("table")).toHaveCount(0);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(650);
    await expect(explorer.getByRole("table")).toBeVisible();
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(650);
  };
  await changeRange("Last 7 days");
  await changeRange("Last 24 hours");

  await page
    .getByRole("button", { name: "Last 24 hours", exact: true })
    .click();
  await page.getByLabel("From", { exact: true }).fill("2026-10-01 00:00");
  await page.getByLabel("To", { exact: true }).fill("2026-10-10 23:59");
  await page.getByRole("button", { name: "Apply time range" }).click();
  await expect(explorer.getByRole("table")).toHaveCount(0);
  await expect(page).toHaveURL(/timeframe=custom/);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(650);
  await expect(explorer.getByRole("table")).toBeVisible();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(650);

  await page.goBack();
  await expect(
    page.getByRole("button", { name: "Last 24 hours", exact: true }),
  ).toBeVisible();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(650);
  await page.goForward();
  await expect(page).toHaveURL(/timeframe=custom/);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(650);

  await mswControl.registerMany([
    { method: "get", url: "/api/limits", body: [] },
    { method: "get", url: "/api/default-user-limits", body: [] },
  ]);
  await page.getByRole("link", { name: "Limits", exact: true }).click();
  await expect(page).toHaveURL(/\/llm\/limits/);
  await expect(
    page.getByRole("heading", { name: "Limits", exact: true }),
  ).toBeVisible();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
});

test("range history preserves the mobile main scroller", async ({
  page,
  mswControl,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mswControl.use({
    method: "get",
    url: "/api/statistics/costs",
    body: costStatisticsFor(new URLSearchParams({ timeframe: "30d" })),
  });
  await page.goto("/llm/costs?timeframe=30d");
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "Last 30 days", exact: true }).click();
  await page.getByRole("button", { name: "Last 7 days", exact: true }).click();
  await expect(page).toHaveURL(/timeframe=7d/);
  await expect(page.getByRole("table")).toBeVisible();
  const scroller = page.getByRole("main");
  await scroller.evaluate((el) => {
    el.scrollTop = 650;
  });
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(650);
  await page.goBack();
  await expect(page).toHaveURL(/timeframe=30d/);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(650);
  await page.goForward();
  await expect(page).toHaveURL(/timeframe=7d/);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(650);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

for (const outcome of ["empty", "error"] as const) {
  test(`a Costs range with ${outcome} results releases the loading space`, async ({
    page,
    mswControl,
  }) => {
    await page.goto("/llm/costs?timeframe=30d");
    const explorer = page.getByRole("region", { name: "Cost explorer" });
    const scroller = page.locator("[data-page-scroll-container]");
    await expect(explorer.getByRole("table")).toBeVisible();
    const height = await scroller.evaluate((el) => el.scrollHeight);
    const empty = costStatisticsFor(new URLSearchParams({ timeframe: "30d" }));
    await mswControl.use({
      method: "get",
      url: "/api/statistics/costs",
      query: { timeframe: "7d" },
      delayMs: 1200,
      status: outcome === "error" ? 500 : 200,
      body:
        outcome === "error"
          ? { error: { message: "Statistics temporarily unavailable" } }
          : {
              ...empty,
              models: [],
              costSavings: { ...empty.costSavings, timeSeries: [] },
            },
    });
    await scroller.evaluate((el) => {
      el.scrollTop = 650;
    });
    await page
      .getByRole("button", { name: "Last 30 days", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Last 7 days", exact: true })
      .click();
    const content = page.locator("[data-page-content] [aria-busy]");
    await expect(content).toHaveAttribute("aria-busy", "true");
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(650);
    await expect(
      page.getByText(
        outcome === "error"
          ? "Could not load usage statistics"
          : "Nothing to tabulate.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(content).toHaveAttribute("aria-busy", "false");
    // A genuinely shorter result may clamp to its new end. Loading must not
    // leave permanent blank space or restore an out-of-bounds old offset.
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight))
      .toBeLessThan(height);
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollTop))
      .toBe(
        await scroller.evaluate((el) =>
          Math.max(0, el.scrollHeight - el.clientHeight),
        ),
      );
  });
}

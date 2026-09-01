import { expect, test } from "../fixtures";

/**
 * A chart legend is laid out by the browser, so the bug this pins — long
 * series names pushing a legend past its card and giving the costs page a
 * sideways scroll on a phone — is only observable with a real layout engine.
 * jsdom has none, so a cheaper level could do no better than re-assert the
 * component's own class list.
 *
 * The statistics response is stubbed rather than seeded: the legend only
 * misbehaves for names long enough to overflow, and nothing else in the suite
 * guarantees the database holds any.
 */
const LONGEST_MODEL_NAME = "deepseek/deepseek-v4-flash-vision-exp";

const MODEL_NAMES = [
  LONGEST_MODEL_NAME,
  "mistralai/mixtral-8x22b-instruct-v0.3",
  "google/gemini-3.7-flash-thinking-preview",
  "openai/gpt-5.6-terra-high-reasoning",
  "meta-llama/llama-4.1-405b-instruct-turbo",
  // A sixth series so the chart is capped at its top five, as it is in
  // production for any organization using more than a handful of models.
  "claude-sonnet-5",
];

/** 24 hourly buckets, so the chart draws a line rather than a single dot. */
const timeSeries = (scale: number) =>
  Array.from({ length: 24 }, (_, hour) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1, hour)).toISOString(),
    value: Number((scale * (1 + Math.sin(hour / 3))).toFixed(2)),
  }));

const modelStatistics = MODEL_NAMES.map((model, index) => {
  const cost = 100 - index * 12;
  return {
    model,
    requests: 500 - index * 20,
    inputTokens: 1_000_000 - index * 1_000,
    outputTokens: 400_000 - index * 1_000,
    cacheReadTokens: 200_000 - index * 1_000,
    cost,
    percentage: 100 / MODEL_NAMES.length,
    timeSeries: timeSeries(cost / 20),
  };
});

// A phone. The legend fits on one row at desktop widths, so the regression is
// invisible there.
test.use({ viewport: { width: 390, height: 844 } });

test("cost chart legends wrap instead of overflowing on a phone", async ({
  page,
  goToPage,
}) => {
  await page.route("**/api/statistics/models*", (route) =>
    route.fulfill({ json: modelStatistics }),
  );

  await goToPage(page, "/llm/costs?timeframe=24h");

  const modelsCard = page
    .locator('[data-slot="card"]')
    .filter({
      has: page.locator('[data-slot="card-title"]', { hasText: /^Models$/ }),
    })
    .first();

  // The legend really is the wide one: its longest label is on screen.
  await expect(modelsCard.getByText(LONGEST_MODEL_NAME).first()).toBeVisible();

  const legend = await modelsCard.evaluate((card) => {
    const wrapper = card.querySelector(".recharts-legend-wrapper");
    if (!wrapper) throw new Error("Models chart rendered without a legend");
    const row = wrapper.firstElementChild as HTMLElement;
    const items = [...row.children] as HTMLElement[];
    const cardBox = card.getBoundingClientRect();

    return {
      itemCount: items.length,
      // How far the worst-placed item pokes out of the card, either side.
      widestEscape: Math.max(
        0,
        ...items.map((item) => {
          const box = item.getBoundingClientRect();
          return Math.max(cardBox.left - box.left, box.right - cardBox.right);
        }),
      ),
      // Content wider than the row is what used to clip the end labels away.
      rowOverflow: row.scrollWidth - row.clientWidth,
      // Wrapping means the labels occupy more than a single line.
      rowLines: new Set(
        items.map((item) => Math.round(item.getBoundingClientRect().top)),
      ).size,
    };
  });

  expect(legend.itemCount).toBe(5);
  expect(legend.widestEscape).toBe(0);
  expect(legend.rowOverflow).toBeLessThanOrEqual(0);
  expect(legend.rowLines).toBeGreaterThan(1);

  // And the page around the card does not gain a sideways scroll. The wide
  // statistics tables have their own `overflow-auto` panels and are meant to
  // scroll; the pane holding the whole page is not.
  const sidewaysScroll = await modelsCard.evaluate((card) => {
    let pane = card.parentElement;
    while (pane) {
      const { overflowX } = getComputedStyle(pane);
      if (overflowX === "auto" || overflowX === "scroll") break;
      pane = pane.parentElement;
    }
    return {
      foundPane: Boolean(pane),
      pane: pane ? pane.scrollWidth - pane.clientWidth : 0,
      document:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    };
  });

  expect(sidewaysScroll.foundPane).toBe(true);
  expect(sidewaysScroll.pane).toBeLessThanOrEqual(0);
  expect(sidewaysScroll.document).toBeLessThanOrEqual(0);
});

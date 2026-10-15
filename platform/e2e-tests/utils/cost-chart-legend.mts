import type { archestraApiTypes } from "@archestra/shared";
import { expect, type Page } from "@playwright/test";

const LONGEST_MODEL_NAME = "deepseek/deepseek-v4-flash-vision-exp";

const MODEL_NAMES = [
  LONGEST_MODEL_NAME,
  "mistralai/mixtral-8x22b-instruct-v0.3",
  "google/gemini-3.7-flash-thinking-preview",
  "openai/gpt-5.6-terra-high-reasoning",
  "meta-llama/llama-4.1-405b-instruct-turbo",
  // Several long series force the explorer legend to wrap on a phone.
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

export const costStatistics = {
  models: modelStatistics,
  costSavings: {
    totalBaselineCost: 420,
    totalActualCost: 420,
    totalSavings: 0,
    totalSubscriptionCost: 0,
    totalCacheSavings: 0,
    timeSeries: [],
  },
  activeUsers: 0,
} satisfies archestraApiTypes.GetCostStatisticsResponses[200];

export async function assertMobileCostLegend(page: Page) {
  const modelsCard = page.getByRole("region", { name: "Cost explorer" });

  // The legend really is the wide one: its longest label is on screen.
  await expect(modelsCard.getByText(LONGEST_MODEL_NAME).first()).toBeVisible();

  const legend = await modelsCard.evaluate((card) => {
    const wrapper = card.querySelector('[aria-label="Usage chart legend"]');
    if (!wrapper) throw new Error("Models chart rendered without a legend");
    const row = wrapper as HTMLElement;
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

  expect(legend.itemCount).toBe(MODEL_NAMES.length);
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
}

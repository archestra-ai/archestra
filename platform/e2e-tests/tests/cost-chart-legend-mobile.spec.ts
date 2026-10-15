import { test } from "../fixtures";

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
import {
  assertMobileCostLegend,
  costStatistics,
} from "../utils/cost-chart-legend.mjs";

// A phone. The legend fits on one row at desktop widths, so the regression is
// invisible there.
test.use({ viewport: { width: 390, height: 844 } });

test("cost chart legends wrap instead of overflowing on a phone", async ({
  page,
  goToPage,
}) => {
  await page.route("**/api/statistics/costs*", (route) =>
    route.fulfill({ json: costStatistics }),
  );

  await goToPage(page, "/llm/costs?timeframe=24h");

  await assertMobileCostLegend(page);
});

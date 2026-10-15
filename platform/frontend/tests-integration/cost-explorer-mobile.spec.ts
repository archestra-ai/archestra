import {
  assertMobileCostLegend,
  costStatistics,
} from "../../e2e-tests/utils/cost-chart-legend.mjs";
import { test } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 } });
test("cost chart legends wrap and the explorer stays within a phone viewport", async ({
  page,
  mswControl,
}) => {
  await mswControl.use({
    method: "get",
    url: "/api/statistics/costs",
    body: costStatistics,
  });
  await page.goto("/llm/costs?timeframe=24h");
  await assertMobileCostLegend(page);
});

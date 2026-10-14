import {
  assertMobileCostLegend,
  modelStatistics,
} from "../../e2e-tests/utils/cost-chart-legend.mjs";
import { test } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 } });
test("cost chart legends wrap and the explorer stays within a phone viewport", async ({
  page,
  mswControl,
}) => {
  await mswControl.registerMany([
    { method: "get", url: "/api/statistics/models", body: modelStatistics },
    {
      method: "get",
      url: "/api/statistics/users",
      body: {
        data: [],
        pagination: {
          limit: 100,
          offset: 0,
          total: 0,
          totalPages: 0,
          currentPage: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
    },
    {
      method: "get",
      url: "/api/statistics/cost-savings",
      body: { totalActualCost: 420, totalSubscriptionCost: 0, timeSeries: [] },
    },
  ]);
  await page.goto("/llm/costs?timeframe=24h");
  await assertMobileCostLegend(page);
});

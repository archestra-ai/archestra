import { describe, expect, test } from "vitest";
import { buildSeriesChartData } from "@/lib/statistics-chart.utils";

describe("buildSeriesChartData", () => {
  test("fills missing timestamp values with zero without dropping labels", () => {
    const data = buildSeriesChartData({
      series: [
        {
          key: "team-a",
          timeSeries: [
            { timestamp: "2026-01-01T00:00:00.000Z", value: 1.5 },
            { timestamp: "2026-01-01T00:01:00.000Z", value: 2.5 },
          ],
        },
        {
          key: "team-b",
          timeSeries: [
            { timestamp: "2026-01-01T00:01:00.000Z", value: 3.5 },
            { timestamp: "2026-01-01T00:02:00.000Z", value: 4.5 },
          ],
        },
      ],
      formatTimestamp: (timestamp) => `label:${timestamp}`,
    });

    expect(data).toEqual([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        label: "label:2026-01-01T00:00:00.000Z",
        "team-a": 1.5,
        "team-b": 0,
      },
      {
        timestamp: "2026-01-01T00:01:00.000Z",
        label: "label:2026-01-01T00:01:00.000Z",
        "team-a": 2.5,
        "team-b": 3.5,
      },
      {
        timestamp: "2026-01-01T00:02:00.000Z",
        label: "label:2026-01-01T00:02:00.000Z",
        "team-a": 0,
        "team-b": 4.5,
      },
    ]);
  });
});

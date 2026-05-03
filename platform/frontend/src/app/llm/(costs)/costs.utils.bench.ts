import { bench, describe } from "vitest";
import { buildSeriesChartData } from "@/lib/statistics-chart.utils";

const series = Array.from({ length: 5 }, (_, seriesIndex) => ({
  key: `series-${seriesIndex}`,
  timeSeries: Array.from({ length: 2_000 }, (_, pointIndex) => ({
    timestamp: new Date(1_700_000_000_000 + pointIndex * 60_000).toISOString(),
    value: seriesIndex + pointIndex / 100,
  })),
}));

function buildSeriesChartDataWithFind() {
  const allTimestamps = [
    ...new Set(
      series.flatMap((item) => item.timeSeries.map((point) => point.timestamp)),
    ),
  ].sort();

  return allTimestamps.map((timestamp) => {
    const dataPoint: Record<string, string | number> = {
      timestamp,
      label: timestamp,
    };
    for (const item of series) {
      const point = item.timeSeries.find((p) => p.timestamp === timestamp);
      dataPoint[item.key] = point ? point.value : 0;
    }
    return dataPoint;
  });
}

describe("cost chart transform", () => {
  bench("old find transform", () => {
    buildSeriesChartDataWithFind();
  });

  bench("new Map transform", () => {
    buildSeriesChartData({ series, formatTimestamp: (timestamp) => timestamp });
  });
});

export type CostChartSeries = {
  key: string;
  timeSeries: Array<{ timestamp: string; value: number }>;
};

export function buildSeriesChartData({
  series,
  formatTimestamp,
}: {
  series: CostChartSeries[];
  formatTimestamp: (timestamp: string) => string;
}): Record<string, string | number>[] {
  if (series.length === 0) return [];

  const allTimestamps = [
    ...new Set(
      series.flatMap((item) => item.timeSeries.map((point) => point.timestamp)),
    ),
  ].sort();

  const seriesWithMaps = series.map((item) => ({
    key: item.key,
    valuesByTimestamp: new Map(
      item.timeSeries.map((point) => [point.timestamp, point.value]),
    ),
  }));

  return allTimestamps.map((timestamp) => {
    const dataPoint: Record<string, string | number> = {
      timestamp,
      label: formatTimestamp(timestamp),
    };
    for (const item of seriesWithMaps) {
      dataPoint[item.key] = item.valuesByTimestamp.get(timestamp) ?? 0;
    }
    return dataPoint;
  });
}

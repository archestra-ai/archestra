"use client";

import { archestraApiSdk, type StatisticsTimeFrame } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils/api";
import type { Cube, MetricId } from "./cost-explorer-data";

export function useModelUsageCube({
  model,
  group,
  metric,
  timeframe,
  own = false,
}: {
  model?: string;
  group: "person" | "key" | "agent" | "client" | "time";
  metric: MetricId;
  timeframe: StatisticsTimeFrame;
  own?: boolean;
}): Cube {
  const groupBy = group === "time" ? "client" : group;
  const query = useQuery({
    queryKey: ["model-usage", own, model, groupBy, timeframe],
    enabled: !!model,
    queryFn: async () => {
      const get = own
        ? archestraApiSdk.getMyModelUsage
        : archestraApiSdk.getModelUsage;
      const rows = [];
      let offset = 0;
      for (;;) {
        const { data, error } = await get({
          query: { model: model ?? "", groupBy, timeframe, limit: 100, offset },
        });
        throwOnApiError(error, { toastOnError: false });
        if (!data) throw new Error("No model usage response received");
        rows.push(...data.data);
        if (!data.pagination.hasNext) break;
        if (data.pagination.limit <= 0 || data.data.length === 0)
          throw new Error("Invalid model usage pagination");
        offset += data.pagination.limit;
      }
      return rows;
    },
  });
  const field =
    metric === "billed"
      ? "billedCost"
      : metric === "subscription"
        ? "subscriptionCost"
        : metric === "tokens"
          ? "totalTokens"
          : metric === "cacheRead"
            ? "cacheReadTokens"
            : metric === "cacheWrite"
              ? "cacheWriteTokens"
              : "requests";
  const data = query.data ?? [];
  const buckets = [
    ...new Set(
      data.flatMap((row) => row.timeSeries.map((point) => point.timestamp)),
    ),
  ].sort();
  const groupedRows = new Map<string, Cube["rows"][number]>();
  for (const row of data) {
    // Personal client families can have several recorded agent identifiers.
    const key = own ? row.name : row.id;
    const current = groupedRows.get(key) ?? {
      key,
      label: row.name,
      sub:
        group === "key" && !row.id.endsWith(":unattributed")
          ? row.id
          : undefined,
      total: 0,
      series: buckets.map(() => 0),
      hasSeries: true,
      children: [],
      extras: { requests: 0, tokens: 0 },
    };
    current.total += row[field];
    current.extras.requests += row.requests;
    current.extras.tokens += row.totalTokens;
    const points = new Map(
      row.timeSeries.map((point) => [point.timestamp, point[field]]),
    );
    for (let index = 0; index < buckets.length; index++)
      current.series[index] += points.get(buckets[index]) ?? 0;
    groupedRows.set(key, current);
  }
  let rows = [...groupedRows.values()].sort((a, b) => b.total - a.total);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  if (group === "time")
    rows = [
      {
        key: "personal",
        label: model ?? "Your usage",
        total,
        series: buckets.map((_, index) =>
          rows.reduce((sum, row) => sum + row.series[index], 0),
        ),
        hasSeries: true,
        children: [],
        extras: { requests: 0, tokens: 0 },
      },
    ];
  return {
    rows,
    buckets,
    total,
    splitKeys: [],
    extraCols: [],
    api: `GET /api/statistics/${own ? "me/" : ""}model-usage?model=${encodeURIComponent(model ?? "")}&groupBy=${groupBy}&timeframe=${encodeURIComponent(String(timeframe))}`,
    isLoading: !!model && query.isPending,
    error: query.error,
    retry: () => {
      void query.refetch();
    },
    notice:
      "Usage for the selected model. Requests without an attributed identity remain visible.",
  };
}

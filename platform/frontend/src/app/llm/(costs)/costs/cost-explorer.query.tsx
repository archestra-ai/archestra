"use client";
import {
  archestraApiSdk,
  type archestraApiTypes,
  type StatisticsTimeFrame,
} from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useSetCostsAction } from "@/app/llm/(costs)/layout";
import { useStatisticsTimeRange } from "@/components/time-range-picker/statistics-time-range";
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker";
import { throwOnApiError } from "@/lib/utils/api";

export type ToolCallUsageDimension = NonNullable<
  NonNullable<archestraApiTypes.GetMcpToolCallUsageData["query"]>["groupBy"]
>[number];
export type AppUsageDimension = NonNullable<
  NonNullable<archestraApiTypes.GetAppUsageData["query"]>["groupBy"]
>[number];
export type SkillUsageDimension = NonNullable<
  NonNullable<archestraApiTypes.GetSkillUsageData["query"]>["groupBy"]
>[number];
type UsageFilters = {
  timeframe: StatisticsTimeFrame;
  userId?: string;
  teamId?: string;
  enabled?: boolean;
  limit?: number;
};
const querySerializer = { array: { style: "form" as const, explode: false } };

export function useCostsTimeRange() {
  const setActionButton = useSetCostsAction();
  const { range, setRange, timeframe, isResolved } = useStatisticsTimeRange({
    storageKey: "cost-statistics-timeframe",
    defaultTimeframe: "1h",
  });
  useEffect(() => {
    setActionButton(
      <TimeRangePicker value={range} onChange={setRange} allowAllTime />,
    );
    return () => setActionButton(null);
  }, [range, setRange, setActionButton]);
  return { timeframe, enabled: isResolved };
}

export function useToolCallUsage({
  groupBy,
  enabled = true,
  mcpServerName,
  ...filters
}: UsageFilters & {
  groupBy: ToolCallUsageDimension[];
  mcpServerName?: string;
}) {
  return useQuery({
    queryKey: [
      "usage-statistics",
      "getMcpToolCallUsage",
      groupBy,
      mcpServerName,
      filters,
    ],
    queryFn: () =>
      collectPages(async (offset) => {
        const { data, error } = await archestraApiSdk.getMcpToolCallUsage({
          query: { ...filters, groupBy, mcpServerName, limit: 100, offset },
          querySerializer,
        });
        throwOnApiError(error, { toastOnError: false });
        if (!data) throw new Error("No usage response received");
        return data;
      }),
    enabled,
  });
}

export function useAppUsage({
  groupBy,
  enabled = true,
  ...filters
}: UsageFilters & { groupBy: AppUsageDimension[] }) {
  return useQuery({
    queryKey: ["usage-statistics", "getAppUsage", groupBy, filters],
    queryFn: () =>
      collectPages(async (offset) => {
        const { data, error } = await archestraApiSdk.getAppUsage({
          query: { ...filters, groupBy, limit: 100, offset },
          querySerializer,
        });
        throwOnApiError(error, { toastOnError: false });
        if (!data) throw new Error("No usage response received");
        return data;
      }),
    enabled,
  });
}

export function useSkillUsage({
  groupBy,
  enabled = true,
  ...filters
}: UsageFilters & { groupBy: SkillUsageDimension[] }) {
  return useQuery({
    queryKey: ["usage-statistics", "getSkillUsage", groupBy, filters],
    queryFn: () =>
      collectPages(async (offset) => {
        const { data, error } = await archestraApiSdk.getSkillUsage({
          query: { ...filters, groupBy, limit: 100, offset },
          querySerializer,
        });
        throwOnApiError(error, { toastOnError: false });
        if (!data) throw new Error("No usage response received");
        return data;
      }),
    enabled,
  });
}

export function useUserUsageWithSeries({
  timeframe,
  limit = 100,
  sortBy = "totalTokens",
  includeTimeSeries = true,
  includeModels = false,
  enabled = true,
}: {
  timeframe: StatisticsTimeFrame;
  limit?: number;
  sortBy?: "totalTokens" | "requests" | "billedCost";
  includeTimeSeries?: boolean;
  includeModels?: boolean;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: [
      "usage-statistics",
      "users",
      timeframe,
      limit,
      sortBy,
      includeTimeSeries,
      includeModels,
    ],
    queryFn: () =>
      collectPages(async (offset) => {
        const { data, error } = await archestraApiSdk.getUserStatistics({
          query: {
            timeframe,
            limit,
            offset,
            sortBy,
            includeTimeSeries: String(includeTimeSeries),
            includeModels: String(includeModels),
            includeModelTimeSeries: String(includeModels),
          },
        });
        throwOnApiError(error, { toastOnError: false });
        if (!data) throw new Error("No user usage response received");
        return data;
      }),
    enabled,
  });
}

export function useAppCostAttribution({
  timeframe,
  enabled,
}: {
  timeframe: StatisticsTimeFrame;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: ["cost-attribution", "getAppStatistics", timeframe],
    queryFn: () =>
      collectPages(async (offset) => {
        const { data, error } = await archestraApiSdk.getAppStatistics({
          query: { timeframe, limit: 100, offset },
        });
        throwOnApiError(error, { toastOnError: false });
        if (!data) throw new Error("No attribution response received");
        return data;
      }),
    enabled,
  });
}

export function useSkillCostAttribution({
  timeframe,
  enabled,
}: {
  timeframe: StatisticsTimeFrame;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: ["cost-attribution", "getSkillStatistics", timeframe],
    queryFn: () =>
      collectPages(async (offset) => {
        const { data, error } = await archestraApiSdk.getSkillStatistics({
          query: { timeframe, limit: 100, offset },
        });
        throwOnApiError(error, { toastOnError: false });
        if (!data) throw new Error("No attribution response received");
        return data;
      }),
    enabled,
  });
}

/** Fetch every group without exceeding the endpoint's per-request limit. */
async function collectPages<
  T extends {
    data: unknown[];
    pagination: { hasNext: boolean; limit: number };
  },
>(request: (offset: number) => Promise<T>): Promise<T> {
  const first = await request(0);
  const rows = [...first.data];
  let next = first;
  let offset = 0;
  while (next.pagination.hasNext) {
    if (next.pagination.limit <= 0 || next.data.length === 0)
      throw new Error("Invalid usage pagination");
    offset += next.pagination.limit;
    next = await request(offset);
    rows.push(...next.data);
  }
  return { ...first, data: rows };
}
/** Shared by headline tiles and the default chart; TanStack deduplicates callers. */
export function useCostStatistics({
  timeframe,
  enabled,
}: {
  timeframe: StatisticsTimeFrame;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: ["statistics", "costs", timeframe],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getCostStatistics({
        query: { timeframe },
      });
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("No cost statistics response received");
      return data;
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function useKpis({
  timeframe,
  enabled,
}: {
  timeframe: StatisticsTimeFrame;
  enabled: boolean;
}) {
  const statistics = useCostStatistics({ timeframe, enabled });

  return useMemo(() => {
    const ts = statistics.data?.costSavings.timeSeries ?? [];
    const modelRows = statistics.data?.models ?? [];
    const byTimestamp = new Map<string, { requests: number; tokens: number }>();
    for (const model of modelRows) {
      for (const point of model.timeSeries) {
        const totals = byTimestamp.get(point.timestamp) ?? {
          requests: 0,
          tokens: 0,
        };
        totals.requests += point.requests ?? 0;
        totals.tokens += point.totalTokens ?? 0;
        byTimestamp.set(point.timestamp, totals);
      }
    }
    const buckets = [...byTimestamp.keys()].sort();
    const requests = buckets.map(
      (bucket) => byTimestamp.get(bucket)?.requests ?? 0,
    );
    const tokens = buckets.map(
      (bucket) => byTimestamp.get(bucket)?.tokens ?? 0,
    );
    return {
      billed: {
        value: statistics.data?.costSavings.totalActualCost ?? 0,
        series: ts.map((p) => p.actualCost),
      },
      subscription: {
        value: statistics.data?.costSavings.totalSubscriptionCost ?? 0,
        series: ts.map((p) => p.subscriptionCost ?? 0),
      },
      requests: {
        value: modelRows.reduce((total, row) => total + row.requests, 0),
        series: requests,
      },
      tokens: {
        value: modelRows.reduce((total, row) => total + row.totalTokens, 0),
        series: tokens,
      },
      people: {
        value: statistics.data?.activeUsers ?? 0,
      },
      isCostPending: statistics.isPending,
      isUsagePending: statistics.isPending,
      isPeoplePending: statistics.isPending,
    };
  }, [statistics.data, statistics.isPending]);
}

export const formatCost = (n: number) =>
  n >= 1000
    ? `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
    : `$${n.toFixed(2)}`;

export const formatCompact = (n: number) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);

export const formatInt = (n: number) =>
  new Intl.NumberFormat("en-US").format(Math.round(n));

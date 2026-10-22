"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils/api";

type Query = NonNullable<archestraApiTypes.GetProxyCostStatisticsData["query"]>;
type Response = archestraApiTypes.GetProxyCostStatisticsResponses["200"];
type LabelGroups = NonNullable<Response["labels"]>["groups"];

export function useProxyLabelCosts({
  enabled,
  ...query
}: Pick<Query, "timeframe" | "labelValue" | "labelUnassigned"> & {
  labelKey: string;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: ["statistics", "proxy-label-costs", query],
    queryFn: async () => {
      const groups: LabelGroups = [];
      for (let offset = 0; ; offset += 100) {
        const { data, error } = await archestraApiSdk.getProxyCostStatistics({
          query: { ...query, limit: 100, offset },
        });
        throwOnApiError(error, { toastOnError: false });
        if (!data?.labels)
          throw new Error("No label attribution response received");
        groups.push(...data.labels.groups);
        if (groups.length >= data.labels.pagination.total)
          return { totals: data.totals, groups };
        if (!data.labels.groups.length)
          throw new Error("Label attribution returned an incomplete page");
      }
    },
    enabled,
    staleTime: 30_000,
  });
}

export function useProxyLabelKeys({
  timeframe,
  enabled,
}: Pick<Query, "timeframe"> & { enabled: boolean }) {
  return useQuery({
    queryKey: ["statistics", "proxy-label-keys", timeframe],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getProxyCostStatistics({
        query: { timeframe, includeLabelKeys: "true", limit: 1 },
      });
      throwOnApiError(error, { toastOnError: false });
      if (!data?.labelKeys)
        throw new Error("No historical label keys received");
      return data.labelKeys;
    },
    enabled,
    staleTime: 30_000,
  });
}

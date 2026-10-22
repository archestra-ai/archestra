"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { labelCostsCsv } from "@/lib/label-costs-csv";
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

export function useCopyLabelCosts() {
  return useMutation({
    mutationFn: async (params: { key: string; groups: LabelGroups }) => {
      await navigator.clipboard.writeText(labelCostsCsv(params));
    },
    onSuccess: () => toast.success("Copied all label values as CSV"),
    onError: () => toast.error("Could not copy cost attribution"),
  });
}

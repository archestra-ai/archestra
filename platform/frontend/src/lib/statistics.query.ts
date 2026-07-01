"use client";

import {
  archestraApiSdk,
  type archestraApiTypes,
  type StatisticsTimeFrame,
} from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils";

const {
  getTeamStatistics,
  getAgentStatistics,
  getModelStatistics,
  getOverviewStatistics,
  getCostSavingsStatistics,
} = archestraApiSdk;

export function useTeamStatistics({
  timeframe = "24h",
  initialData,
}: {
  timeframe?: StatisticsTimeFrame;
  initialData?: archestraApiTypes.GetTeamStatisticsResponses["200"];
} = {}) {
  return useQuery({
    queryKey: ["statistics", "teams", timeframe],
    queryFn: async () => {
      const { data, error } = await getTeamStatistics({
        query: { timeframe },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    initialData,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

export function useProfileStatistics({
  timeframe = "24h",
  initialData,
}: {
  timeframe?: StatisticsTimeFrame;
  initialData?: archestraApiTypes.GetAgentStatisticsResponses["200"];
} = {}) {
  return useQuery({
    queryKey: ["statistics", "agents", timeframe],
    queryFn: async () => {
      const { data, error } = await getAgentStatistics({
        query: { timeframe },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    initialData,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

export function useModelStatistics({
  timeframe = "24h",
  initialData,
}: {
  timeframe?: StatisticsTimeFrame;
  initialData?: archestraApiTypes.GetModelStatisticsResponses["200"];
} = {}) {
  return useQuery({
    queryKey: ["statistics", "models", timeframe],
    queryFn: async () => {
      const { data, error } = await getModelStatistics({
        query: { timeframe },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    initialData,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

export function useOverviewStatistics({
  timeframe = "24h",
  initialData,
}: {
  timeframe?: StatisticsTimeFrame;
  initialData?: archestraApiTypes.GetOverviewStatisticsResponses["200"];
} = {}) {
  return useQuery({
    queryKey: ["statistics", "overview", timeframe],
    queryFn: async () => {
      const { data, error } = await getOverviewStatistics({
        query: { timeframe },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    initialData,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

export function useCostSavingsStatistics({
  timeframe = "24h",
  initialData,
}: {
  timeframe?: StatisticsTimeFrame;
  initialData?: archestraApiTypes.GetCostSavingsStatisticsResponses["200"];
} = {}) {
  return useQuery({
    queryKey: ["statistics", "cost-savings", timeframe],
    queryFn: async () => {
      const { data, error } = await getCostSavingsStatistics({
        query: { timeframe },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    initialData,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

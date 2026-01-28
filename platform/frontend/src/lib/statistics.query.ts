"use client";

import {
  archestraApiSdk,
  type archestraApiTypes,
  type StatisticsTimeFrame,
} from "@shared";
import { useQuery } from "@tanstack/react-query";

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
      const response = await getTeamStatistics({
        query: { timeframe },
      });
      return response.data;
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
      const response = await getAgentStatistics({
        query: { timeframe },
      });
      return response.data;
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
      const response = await getModelStatistics({
        query: { timeframe },
      });
      return response.data;
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
      const response = await getOverviewStatistics({
        query: { timeframe },
      });
      return response.data;
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
      const response = await getCostSavingsStatistics({
        query: { timeframe },
      });
      return response.data;
    },
    initialData,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

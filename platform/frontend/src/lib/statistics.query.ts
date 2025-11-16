"use client";

import {
  archestraApiSdk,
  type archestraApiTypes,
  type StatisticsTimeFrame,
} from "@shared";
import { useSuspenseQuery } from "@tanstack/react-query";

const {
  getTeamStatistics,
  getAgentStatistics,
  getModelStatistics,
  getOverviewStatistics,
} = archestraApiSdk;

export function useTeamStatistics({
  timeframe = "24h",
  initialData,
}: {
  timeframe?: StatisticsTimeFrame;
  initialData?: archestraApiTypes.GetTeamStatisticsResponses["200"];
} = {}) {
  return useSuspenseQuery({
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

export function useAgentStatistics({
  timeframe = "24h",
  initialData,
}: {
  timeframe?: StatisticsTimeFrame;
  initialData?: archestraApiTypes.GetAgentStatisticsResponses["200"];
} = {}) {
  return useSuspenseQuery({
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
  return useSuspenseQuery({
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
  return useSuspenseQuery({
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

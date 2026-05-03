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

export function getStatisticsRefetchInterval(
  timeframe: StatisticsTimeFrame,
  now = Date.now(),
): number | false {
  if (timeframe.startsWith("custom:")) {
    const [, endTime] = timeframe.slice("custom:".length).split("_");
    const endTimestamp = Date.parse(endTime ?? "");
    if (!Number.isNaN(endTimestamp) && endTimestamp < now) {
      return false;
    }
  }
  return 30_000;
}

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
    refetchInterval: getStatisticsRefetchInterval(timeframe),
    refetchIntervalInBackground: false,
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
    refetchInterval: getStatisticsRefetchInterval(timeframe),
    refetchIntervalInBackground: false,
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
    refetchInterval: getStatisticsRefetchInterval(timeframe),
    refetchIntervalInBackground: false,
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
    refetchInterval: getStatisticsRefetchInterval(timeframe),
    refetchIntervalInBackground: false,
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
    refetchInterval: getStatisticsRefetchInterval(timeframe),
    refetchIntervalInBackground: false,
  });
}

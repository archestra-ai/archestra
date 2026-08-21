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
  getUserStatistics,
  getMyStatistics,
  getAppStatistics,
  getSkillStatistics,
  getOverviewStatistics,
  getCostSavingsStatistics,
} = archestraApiSdk;

/**
 * The signed-in user's own cost and usage. The one statistics hook that needs
 * no `llmCost:read`, so it stays enabled on the Costs page for people who see
 * none of the organization-wide charts.
 */
export function useMyStatistics({
  timeframe = "24h",
  enabled = true,
}: {
  timeframe?: StatisticsTimeFrame;
  enabled?: boolean;
} = {}) {
  return useQuery({
    queryKey: ["statistics", "me", timeframe],
    queryFn: async () => {
      const { data, error } = await getMyStatistics({ query: { timeframe } });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    enabled,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

/**
 * Per-user usage. Unlike the sibling statistics hooks this one is paginated —
 * an org can have far more users than teams or models — so callers pass the
 * page size they intend to render.
 */
export function useUserStatistics({
  timeframe = "24h",
  limit = 10,
  offset = 0,
  sortBy = "totalTokens",
  includeModels = false,
  enabled = true,
}: {
  timeframe?: StatisticsTimeFrame;
  limit?: number;
  offset?: number;
  sortBy?: "totalTokens" | "requests" | "billedCost" | "lastActiveAt";
  includeModels?: boolean;
  enabled?: boolean;
} = {}) {
  return useQuery({
    queryKey: [
      "statistics",
      "users",
      timeframe,
      limit,
      offset,
      sortBy,
      includeModels,
    ],
    queryFn: async () => {
      const { data, error } = await getUserStatistics({
        // `includeModels` is a string over the wire: the endpoint parses
        // "true"/"false" explicitly rather than coercing, so that an explicit
        // `false` is not read as truthy.
        query: {
          timeframe,
          limit,
          offset,
          sortBy,
          includeModels: String(includeModels),
        },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    enabled,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

/**
 * Per-MCP-App cost: build spend, runtime spend, and the estimated saving versus
 * doing the same work in chat. Paginated like the per-user hook — app
 * cardinality is unbounded and this renders a leaderboard.
 */
export function useAppStatistics({
  timeframe = "24h",
  limit = 10,
  offset = 0,
  sortBy = "totalCost",
  enabled = true,
}: {
  timeframe?: StatisticsTimeFrame;
  limit?: number;
  offset?: number;
  sortBy?:
    | "totalCost"
    | "buildCost"
    | "runtimeCost"
    | "runs"
    | "estimatedNetSavings"
    | "appName";
  enabled?: boolean;
} = {}) {
  return useQuery({
    queryKey: ["statistics", "apps", timeframe, limit, offset, sortBy],
    queryFn: async () => {
      const { data, error } = await getAppStatistics({
        query: { timeframe, limit, offset, sortBy },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    enabled,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

/**
 * Per-skill cost: the tokens each skill's activations inject into the context,
 * and the spend of the turns that then ran with it.
 */
export function useSkillStatistics({
  timeframe = "24h",
  limit = 10,
  offset = 0,
  sortBy = "contextTokens",
  enabled = true,
}: {
  timeframe?: StatisticsTimeFrame;
  limit?: number;
  offset?: number;
  sortBy?: "contextTokens" | "activations" | "lastActivatedAt" | "skillName";
  enabled?: boolean;
} = {}) {
  return useQuery({
    queryKey: ["statistics", "skills", timeframe, limit, offset, sortBy],
    queryFn: async () => {
      const { data, error } = await getSkillStatistics({
        query: { timeframe, limit, offset, sortBy },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    enabled,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

export function useTeamStatistics({
  timeframe = "24h",
  initialData,
  enabled = true,
}: {
  timeframe?: StatisticsTimeFrame;
  initialData?: archestraApiTypes.GetTeamStatisticsResponses["200"];
  enabled?: boolean;
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
    enabled,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

export function useProfileStatistics({
  timeframe = "24h",
  initialData,
  enabled = true,
}: {
  timeframe?: StatisticsTimeFrame;
  initialData?: archestraApiTypes.GetAgentStatisticsResponses["200"];
  enabled?: boolean;
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
    enabled,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

export function useModelStatistics({
  timeframe = "24h",
  initialData,
  enabled = true,
}: {
  timeframe?: StatisticsTimeFrame;
  initialData?: archestraApiTypes.GetModelStatisticsResponses["200"];
  enabled?: boolean;
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
    enabled,
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
  enabled = true,
}: {
  timeframe?: StatisticsTimeFrame;
  initialData?: archestraApiTypes.GetCostSavingsStatisticsResponses["200"];
  enabled?: boolean;
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
    enabled,
    refetchInterval: 30_000, // Refresh every 30 seconds
  });
}

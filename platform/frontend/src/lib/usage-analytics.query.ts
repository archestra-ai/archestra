import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

// Types
export const UsagePeriodSchema = z.enum(["daily", "weekly", "monthly"]);
export type UsagePeriod = z.infer<typeof UsagePeriodSchema>;

export const UsageGroupBySchema = z.enum([
  "team",
  "agent",
  "provider",
  "model",
]);
export type UsageGroupBy = z.infer<typeof UsageGroupBySchema>;

export const UsageBreakdownSchema = z.object({
  id: z.string(),
  name: z.string(),
  cost: z.number(),
  percentage: z.number(),
  calls: z.number().optional(),
  tokens: z.number().optional(),
});
export type UsageBreakdown = z.infer<typeof UsageBreakdownSchema>;

export const UsageCostSummarySchema = z.object({
  currentSpend: z.number(),
  budgetLimit: z.number().optional(),
  period: UsagePeriodSchema,
});
export type UsageCostSummary = z.infer<typeof UsageCostSummarySchema>;

// Query keys
const usageAnalyticsKeys = {
  all: ["usage-analytics"] as const,
  breakdown: (period: UsagePeriod, groupBy: UsageGroupBy) =>
    [...usageAnalyticsKeys.all, "breakdown", period, groupBy] as const,
  costSummary: (period: UsagePeriod) =>
    [...usageAnalyticsKeys.all, "cost-summary", period] as const,
};

// Hooks
export const useUsageBreakdown = (
  period: UsagePeriod = "daily",
  groupBy: UsageGroupBy = "team",
) => {
  return useQuery({
    queryKey: usageAnalyticsKeys.breakdown(period, groupBy),
    queryFn: async () => {
      const params = new URLSearchParams({
        period,
        groupBy,
      });

      const response = await fetch(`/api/usage/breakdown?${params}`, {
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error("Failed to fetch usage breakdown");
      }

      const data = await response.json();
      return z.array(UsageBreakdownSchema).parse(data);
    },
    staleTime: 1000 * 60 * 5, // Consider data fresh for 5 minutes
    refetchInterval: 1000 * 60 * 5, // Refetch every 5 minutes
  });
};

export const useCostSummary = (period: UsagePeriod = "daily") => {
  return useQuery({
    queryKey: usageAnalyticsKeys.costSummary(period),
    queryFn: async () => {
      const params = new URLSearchParams({ period });

      const response = await fetch(`/api/usage/cost-summary?${params}`, {
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error("Failed to fetch cost summary");
      }

      const data = await response.json();
      return UsageCostSummarySchema.parse(data);
    },
    staleTime: 1000 * 60 * 5, // Consider data fresh for 5 minutes
    refetchInterval: 1000 * 60 * 5, // Refetch every 5 minutes
  });
};

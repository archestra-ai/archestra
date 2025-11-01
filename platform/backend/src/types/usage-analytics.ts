import { z } from "zod";

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

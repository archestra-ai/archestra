import { z } from "zod";

export const StatisticsTimeSeriesPointSchema = z.object({
  timestamp: z.string(),
  value: z.number(),
});

export const TeamStatisticsSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  members: z.number(),
  agents: z.number(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
  timeSeries: z.array(StatisticsTimeSeriesPointSchema),
});

export const AgentStatisticsSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  agentType: z.string(),
  teamName: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cost: z.number(),
  timeSeries: z.array(StatisticsTimeSeriesPointSchema),
});

export const ModelStatisticsSchema = z.object({
  model: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cost: z.number(),
  percentage: z.number(),
  timeSeries: z.array(StatisticsTimeSeriesPointSchema),
});

/**
 * One model's slice of a single user's usage. Present only when the caller asks
 * for the per-model cut (`includeModels`), since it costs an extra aggregation.
 */
export const UserModelUsageSchema = z.object({
  model: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  billedCost: z.number(),
  subscriptionCost: z.number(),
});

/**
 * Per-user usage, for adoption reporting ("who is using AI, how much, on which
 * models") rather than spend reporting.
 *
 * Tokens and requests are the primary metrics on purpose. Cost alone is
 * misleading here: subscription-fulfilled traffic (e.g. a coding agent on a
 * flat-rate plan) incurs no per-token charge, so a cost-keyed view reports 0
 * for exactly the heaviest users. `billedCost` and `subscriptionCost` are kept
 * separate so neither is mistaken for the other.
 */
export const UserStatisticsSchema = z.object({
  userId: z.string(),
  userName: z.string(),
  /** Included so callers can join to an external roster without a second request. */
  userEmail: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTokens: z.number(),
  /** Billed spend: list-price `cost` of metered rows only. */
  billedCost: z.number(),
  /** Would-be list-price cost of subscription-covered rows — not billed. */
  subscriptionCost: z.number(),
  /** Distinct UTC days with at least one request in the timeframe. */
  activeDays: z.number(),
  lastActiveAt: z.string().nullable(),
  /** Present only when `includeModels` is set. */
  models: z.array(UserModelUsageSchema).optional(),
  /** Present only when `includeTimeSeries` is set. */
  timeSeries: z.array(StatisticsTimeSeriesPointSchema).optional(),
});

/**
 * Sortable columns for the per-user view. Defaults to `totalTokens` because
 * adoption is measured in usage, not spend.
 */
export const USER_STATISTICS_SORT_BY = [
  "totalTokens",
  "requests",
  "billedCost",
  "lastActiveAt",
  "userName",
] as const;

export const UserStatisticsSortBySchema = z.enum(USER_STATISTICS_SORT_BY);

export const OverviewStatisticsSchema = z.object({
  totalRequests: z.number(),
  totalTokens: z.number(),
  totalCost: z.number(),
  topTeam: z.string(),
  topAgent: z.string(),
  topModel: z.string(),
});

export const CostSavingsStatisticsSchema = z.object({
  totalBaselineCost: z.number(),
  /** Billed spend: metered `cost` only (subscription traffic excluded). */
  totalActualCost: z.number(),
  totalSavings: z.number(),
  /**
   * Would-be list-price cost of subscription-covered traffic (Claude Code on a
   * Max/Pro plan, etc.) — not billed. Reported separately from optimization
   * savings so it is never conflated with money actually saved.
   */
  totalSubscriptionCost: z.number(),
  totalOptimizationSavings: z.number(),
  totalToonSavings: z.number(),
  totalCacheSavings: z.number(),
  timeSeries: z.array(
    z.object({
      timestamp: z.string(),
      baselineCost: z.number(),
      actualCost: z.number(),
      optimizationSavings: z.number(),
      toonSavings: z.number(),
      cacheSavings: z.number(),
      subscriptionCost: z.number(),
    }),
  ),
});

const BaseTimeSeriesDataSchema = z.object({
  timeBucket: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(), // Stored cost from interactions (already calculated per-model)
});

export const StatisticsTeamTimeSeriesDataSchema =
  BaseTimeSeriesDataSchema.extend({
    teamId: z.string(),
    teamName: z.string(),
  });

export const StatisticsAgentTimeSeriesDataSchema =
  BaseTimeSeriesDataSchema.extend({
    agentId: z.string(),
    agentName: z.string(),
    agentType: z.string(),
    teamName: z.string().nullable(),
  });

export const StatisticsModelTimeSeriesDataSchema =
  BaseTimeSeriesDataSchema.extend({
    model: z.string().nullable(),
  });

export const StatisticsUserTimeSeriesDataSchema =
  BaseTimeSeriesDataSchema.extend({
    userId: z.string(),
  });

export const StatisticsTimeSeriesDataSchema = z.union([
  StatisticsTeamTimeSeriesDataSchema,
  StatisticsAgentTimeSeriesDataSchema,
  StatisticsModelTimeSeriesDataSchema,
  StatisticsUserTimeSeriesDataSchema,
]);

export type StatisticsTimeSeriesPoint = z.infer<
  typeof StatisticsTimeSeriesPointSchema
>;
export type TeamStatistics = z.infer<typeof TeamStatisticsSchema>;
export type AgentStatistics = z.infer<typeof AgentStatisticsSchema>;
export type ModelStatistics = z.infer<typeof ModelStatisticsSchema>;
export type UserStatistics = z.infer<typeof UserStatisticsSchema>;
export type UserModelUsage = z.infer<typeof UserModelUsageSchema>;
export type UserStatisticsSortBy = z.infer<typeof UserStatisticsSortBySchema>;
export type OverviewStatistics = z.infer<typeof OverviewStatisticsSchema>;
export type CostSavingsStatistics = z.infer<typeof CostSavingsStatisticsSchema>;

export type StatisticsTeamTimeSeriesData = z.infer<
  typeof StatisticsTeamTimeSeriesDataSchema
>;
export type StatisticsAgentTimeSeriesData = z.infer<
  typeof StatisticsAgentTimeSeriesDataSchema
>;
export type StatisticsModelTimeSeriesData = z.infer<
  typeof StatisticsModelTimeSeriesDataSchema
>;
export type StatisticsUserTimeSeriesData = z.infer<
  typeof StatisticsUserTimeSeriesDataSchema
>;
export type StatisticsTimeSeriesData = z.infer<
  typeof StatisticsTimeSeriesDataSchema
>;

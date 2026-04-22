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
  cost: z.number(),
  timeSeries: z.array(StatisticsTimeSeriesPointSchema),
});

export const ModelStatisticsSchema = z.object({
  model: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
  percentage: z.number(),
  timeSeries: z.array(StatisticsTimeSeriesPointSchema),
});

export const OverviewStatisticsSchema = z.object({
  totalRequests: z.number(),
  totalTokens: z.number(),
  totalCost: z.number(),
  topTeam: z.string(),
  topAgent: z.string(),
  topModel: z.string(),
});

export const UserStatisticsSchema = z.object({
  userId: z.string(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
  timeSeries: z.array(StatisticsTimeSeriesPointSchema),
});

export const VirtualKeyStatisticsSchema = z.object({
  virtualKeyId: z.string(),
  virtualKeyName: z.string().nullable(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
  timeSeries: z.array(StatisticsTimeSeriesPointSchema),
});

export const CostSavingsStatisticsSchema = z.object({
  totalBaselineCost: z.number(),
  totalActualCost: z.number(),
  totalSavings: z.number(),
  totalOptimizationSavings: z.number(),
  totalToonSavings: z.number(),
  timeSeries: z.array(
    z.object({
      timestamp: z.string(),
      baselineCost: z.number(),
      actualCost: z.number(),
      optimizationSavings: z.number(),
      toonSavings: z.number(),
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

export const StatisticsTimeSeriesDataSchema = z.union([
  StatisticsTeamTimeSeriesDataSchema,
  StatisticsAgentTimeSeriesDataSchema,
  StatisticsModelTimeSeriesDataSchema,
]);

export type StatisticsTimeSeriesPoint = z.infer<
  typeof StatisticsTimeSeriesPointSchema
>;
export type TeamStatistics = z.infer<typeof TeamStatisticsSchema>;
export type AgentStatistics = z.infer<typeof AgentStatisticsSchema>;
export type ModelStatistics = z.infer<typeof ModelStatisticsSchema>;
export type OverviewStatistics = z.infer<typeof OverviewStatisticsSchema>;
export type CostSavingsStatistics = z.infer<typeof CostSavingsStatisticsSchema>;
export type UserStatistics = z.infer<typeof UserStatisticsSchema>;
export type VirtualKeyStatistics = z.infer<typeof VirtualKeyStatisticsSchema>;

export type StatisticsTeamTimeSeriesData = z.infer<
  typeof StatisticsTeamTimeSeriesDataSchema
>;
export type StatisticsAgentTimeSeriesData = z.infer<
  typeof StatisticsAgentTimeSeriesDataSchema
>;
export type StatisticsModelTimeSeriesData = z.infer<
  typeof StatisticsModelTimeSeriesDataSchema
>;
export type StatisticsTimeSeriesData = z.infer<
  typeof StatisticsTimeSeriesDataSchema
>;

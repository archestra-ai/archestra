import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import StatisticsModel from "@/models/statistics";
import { constructResponseSchema, RouteId } from "@/types";

const TimeFrameSchema = z.enum(["1h", "24h", "7d", "30d", "90d", "12m", "all"]);

const TimeSeriesPointSchema = z.object({
  timestamp: z.string(),
  value: z.number(),
});

const StatisticsQuerySchema = z.object({
  timeframe: TimeFrameSchema.optional().default("24h"),
});

const statisticsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/statistics/teams",
    {
      schema: {
        operationId: RouteId.GetTeamStatistics,
        description: "Get team statistics",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(
          z.array(
            z.object({
              teamId: z.string(),
              teamName: z.string(),
              members: z.number(),
              agents: z.number(),
              requests: z.number(),
              inputTokens: z.number(),
              outputTokens: z.number(),
              cost: z.number(),
              timeSeries: z.array(TimeSeriesPointSchema),
            }),
          ),
        ),
      },
    },
    async ({ query: { timeframe } }, reply) => {
      return reply.send(await StatisticsModel.getTeamStatistics(timeframe));
    },
  );

  fastify.get(
    "/api/statistics/agents",
    {
      schema: {
        operationId: RouteId.GetAgentStatistics,
        description: "Get agent statistics",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(
          z.array(
            z.object({
              agentId: z.string(),
              agentName: z.string(),
              teamName: z.string(),
              requests: z.number(),
              inputTokens: z.number(),
              outputTokens: z.number(),
              cost: z.number(),
              timeSeries: z.array(TimeSeriesPointSchema),
            }),
          ),
        ),
      },
    },
    async ({ query: { timeframe }, user }, reply) => {
      return reply.send(
        await StatisticsModel.getAgentStatistics(timeframe, user.id),
      );
    },
  );

  fastify.get(
    "/api/statistics/models",
    {
      schema: {
        operationId: RouteId.GetModelStatistics,
        description: "Get model statistics",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(
          z.array(
            z.object({
              model: z.string(),
              requests: z.number(),
              inputTokens: z.number(),
              outputTokens: z.number(),
              cost: z.number(),
              percentage: z.number(),
              timeSeries: z.array(TimeSeriesPointSchema),
            }),
          ),
        ),
      },
    },
    async ({ query: { timeframe }, user }, reply) => {
      return reply.send(
        await StatisticsModel.getModelStatistics(timeframe, user.id),
      );
    },
  );

  fastify.get(
    "/api/statistics/overview",
    {
      schema: {
        operationId: RouteId.GetOverviewStatistics,
        description: "Get overview statistics",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(
          z.object({
            totalRequests: z.number(),
            totalTokens: z.number(),
            totalCost: z.number(),
            topTeam: z.string(),
            topAgent: z.string(),
            topModel: z.string(),
          }),
        ),
      },
    },
    async ({ query: { timeframe }, user }, reply) => {
      return reply.send(
        await StatisticsModel.getOverviewStatistics(timeframe, user.id),
      );
    },
  );
};

export default statisticsRoutes;

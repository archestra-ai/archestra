import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import StatisticsModel, { type TimeFrame } from "@/models/statistics";
import { ErrorResponseSchema, RouteId } from "@/types";
import { getUserFromRequest } from "@/utils";

const TimeFrameSchema = z.enum(["1h", "24h", "7d", "30d", "90d", "12m", "all"]);

const TimeSeriesPointSchema = z.object({
  timestamp: z.string(),
  value: z.number(),
});

const TeamStatisticsSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  members: z.number(),
  agents: z.number(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
  timeSeries: z.array(TimeSeriesPointSchema),
});

const AgentStatisticsSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  teamName: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
  timeSeries: z.array(TimeSeriesPointSchema),
});

const ModelStatisticsSchema = z.object({
  model: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
  percentage: z.number(),
  timeSeries: z.array(TimeSeriesPointSchema),
});

const OverviewStatisticsSchema = z.object({
  totalRequests: z.number(),
  totalTokens: z.number(),
  totalCost: z.number(),
  topTeam: z.string(),
  topAgent: z.string(),
  topModel: z.string(),
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
        response: {
          200: z.array(TeamStatisticsSchema),
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);

      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const { timeframe } = request.query;
      const statistics = await StatisticsModel.getTeamStatistics(
        timeframe as TimeFrame,
        user.id,
        user.isAdmin,
      );

      return reply.send(statistics);
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
        response: {
          200: z.array(AgentStatisticsSchema),
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);

      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const { timeframe } = request.query;
      const statistics = await StatisticsModel.getAgentStatistics(
        timeframe as TimeFrame,
        user.id,
        user.isAdmin,
      );

      return reply.send(statistics);
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
        response: {
          200: z.array(ModelStatisticsSchema),
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);

      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const { timeframe } = request.query;
      const statistics = await StatisticsModel.getModelStatistics(
        timeframe as TimeFrame,
        user.id,
        user.isAdmin,
      );

      return reply.send(statistics);
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
        response: {
          200: OverviewStatisticsSchema,
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);

      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const { timeframe } = request.query;
      const statistics = await StatisticsModel.getOverviewStatistics(
        timeframe as TimeFrame,
        user.id,
        user.isAdmin,
      );

      return reply.send(statistics);
    },
  );
};

export default statisticsRoutes;

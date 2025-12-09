import { RouteId, StatisticsTimeFrameSchema } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { StatisticsModel } from "@/models";
import {
  AgentStatisticsSchema,
  CostSavingsStatisticsSchema,
  constructResponseSchema,
  ModelStatisticsSchema,
  OverviewStatisticsSchema,
  TeamStatisticsSchema,
} from "@/types";

const StatisticsQuerySchema = z.object({
  timeframe: StatisticsTimeFrameSchema.optional().default("24h"),
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
        response: constructResponseSchema(z.array(TeamStatisticsSchema)),
      },
    },
    async ({ query: { timeframe }, user, headers }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );
      return reply.send(
        await StatisticsModel.getTeamStatistics(
          timeframe,
          user.id,
          isAgentAdmin,
        ),
      );
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
        response: constructResponseSchema(z.array(AgentStatisticsSchema)),
      },
    },
    async ({ query: { timeframe }, user, headers }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      return reply.send(
        await StatisticsModel.getAgentStatistics(
          timeframe,
          user.id,
          isAgentAdmin,
        ),
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
        response: constructResponseSchema(z.array(ModelStatisticsSchema)),
      },
    },
    async ({ query: { timeframe }, user, headers }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      return reply.send(
        await StatisticsModel.getModelStatistics(
          timeframe,
          user.id,
          isAgentAdmin,
        ),
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
        response: constructResponseSchema(OverviewStatisticsSchema),
      },
    },
    async ({ query: { timeframe }, user, headers }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      return reply.send(
        await StatisticsModel.getOverviewStatistics(
          timeframe,
          user.id,
          isAgentAdmin,
        ),
      );
    },
  );

  fastify.get(
    "/api/statistics/cost-savings",
    {
      schema: {
        operationId: RouteId.GetCostSavingsStatistics,
        description: "Get cost savings statistics",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(CostSavingsStatisticsSchema),
      },
    },
    async ({ query: { timeframe }, user, headers }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      return reply.send(
        await StatisticsModel.getCostSavingsStatistics(
          timeframe,
          user.id,
          isAgentAdmin,
        ),
      );
    },
  );
};

export default statisticsRoutes;

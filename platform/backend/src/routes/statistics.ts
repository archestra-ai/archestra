import { RouteId, StatisticsTimeFrameSchema } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import { StatisticsModel } from "@/models";
import {
  AgentStatisticsSchema,
  CostSavingsStatisticsSchema,
  constructResponseSchema,
  ModelStatisticsSchema,
  OverviewStatisticsSchema,
  TeamStatisticsSchema,
  UserStatisticsSchema,
  VirtualKeyStatisticsSchema,
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
    async ({ query: { timeframe }, user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
      return reply.send(
        await StatisticsModel.getTeamStatistics({
          timeframe,
          userId: user.id,
          isAgentAdmin,
        }),
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
    async ({ query: { timeframe }, user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      return reply.send(
        await StatisticsModel.getAgentStatistics({
          timeframe,
          userId: user.id,
          isAgentAdmin,
        }),
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
    async ({ query: { timeframe }, user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      return reply.send(
        await StatisticsModel.getModelStatistics({
          timeframe,
          userId: user.id,
          isAgentAdmin,
        }),
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
    async ({ query: { timeframe }, user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      return reply.send(
        await StatisticsModel.getOverviewStatistics({
          timeframe,
          userId: user.id,
          isAgentAdmin,
        }),
      );
    },
  );

  fastify.get(
    "/api/statistics/users",
    {
      schema: {
        operationId: RouteId.GetUserStatistics,
        description:
          "Per-user cost breakdown grouped by interactions.billed_user_id",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(z.array(UserStatisticsSchema)),
      },
    },
    async ({ query: { timeframe }, user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
      return reply.send(
        await StatisticsModel.getUserStatistics({
          timeframe,
          organizationId,
          userId: user.id,
          isAgentAdmin,
        }),
      );
    },
  );

  fastify.get(
    "/api/statistics/virtual-keys",
    {
      schema: {
        operationId: RouteId.GetVirtualKeyStatistics,
        description:
          "Per-virtual-key cost breakdown grouped by interactions.virtual_api_key_id",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(z.array(VirtualKeyStatisticsSchema)),
      },
    },
    async ({ query: { timeframe }, user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
      return reply.send(
        await StatisticsModel.getVirtualKeyStatistics({
          timeframe,
          userId: user.id,
          organizationId,
          isAgentAdmin,
        }),
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
    async ({ query: { timeframe }, user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      return reply.send(
        await StatisticsModel.getCostSavingsStatistics({
          timeframe,
          userId: user.id,
          isAgentAdmin,
        }),
      );
    },
  );
};

export default statisticsRoutes;

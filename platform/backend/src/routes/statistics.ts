import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
  StatisticsTimeFrameSchema,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission, hasPermission } from "@/auth";
import { StatisticsModel } from "@/models";
import {
  AgentStatisticsSchema,
  CostSavingsStatisticsSchema,
  constructResponseSchema,
  createSortingQuerySchema,
  ModelStatisticsSchema,
  OverviewStatisticsSchema,
  TeamStatisticsSchema,
  USER_STATISTICS_SORT_BY,
  UserStatisticsSchema,
} from "@/types";

const StatisticsQuerySchema = z.object({
  timeframe: StatisticsTimeFrameSchema.optional().default("24h"),
});

const UserStatisticsQuerySchema = StatisticsQuerySchema.extend({
  includeTimeSeries: z
    .stringbool()
    .optional()
    .default(false)
    .describe(
      "Include a per-user cost time series. Off by default: it multiplies the response by the number of time buckets.",
    ),
  includeModels: z
    .stringbool()
    .optional()
    .default(false)
    .describe(
      "Include each user's per-model usage breakdown. Off by default: it costs an extra aggregation.",
    ),
})
  .merge(PaginationQuerySchema)
  .merge(createSortingQuerySchema(USER_STATISTICS_SORT_BY));

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
    async ({ query: { timeframe }, user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

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
    async ({ query: { timeframe }, user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

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
    "/api/statistics/users",
    {
      schema: {
        operationId: RouteId.GetUserStatistics,
        description:
          "Get per-user usage statistics (requests, tokens, cost and model mix), for AI-adoption reporting. Paginated because user cardinality is unbounded. Only traffic that carries a resolved user identity is included; requests authenticated with a shared credential and no user context are not attributed to anyone.",
        tags: ["Statistics"],
        querystring: UserStatisticsQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(UserStatisticsSchema),
        ),
      },
    },
    async (
      {
        query: {
          timeframe,
          includeTimeSeries,
          includeModels,
          limit,
          offset,
          sortBy,
          sortDirection,
        },
        user,
        organizationId,
        headers,
        serviceAccount,
      },
      reply,
    ) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      // Seeing other people's usage implies seeing the roster, so it is gated
      // on the same permission that gates the full member list. Without it the
      // model narrows results to the caller's own usage.
      const { success: canReadAllUsers } = await hasPermission(
        { member: ["read"] },
        headers,
        serviceAccount,
        { userId: user.id, organizationId },
      );

      return reply.send(
        await StatisticsModel.getUserStatistics({
          timeframe,
          pagination: { limit, offset },
          sortBy: sortBy ?? "totalTokens",
          sortDirection,
          includeTimeSeries,
          includeModels,
          requestingUserId: user.id,
          isAgentAdmin,
          canReadAllUsers,
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
    async ({ query: { timeframe }, user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

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

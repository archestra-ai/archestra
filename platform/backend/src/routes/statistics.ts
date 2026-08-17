import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
  StatisticsTimeFrameSchema,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission, hasPermission } from "@/auth";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import { AppAccessModel, SkillTeamModel, StatisticsModel } from "@/models";
import { callerIsAppAdmin } from "@/services/apps/app-authorization";
import {
  AgentStatisticsSchema,
  APP_STATISTICS_SORT_BY,
  AppStatisticsSchema,
  ChatCostBaselineSchema,
  CostSavingsStatisticsSchema,
  constructResponseSchema,
  createSortingQuerySchema,
  ModelStatisticsSchema,
  OverviewStatisticsSchema,
  SKILL_STATISTICS_SORT_BY,
  SkillStatisticsSchema,
  TeamStatisticsSchema,
  USER_STATISTICS_SORT_BY,
  UserStatisticsSchema,
} from "@/types";

const StatisticsQuerySchema = z.object({
  timeframe: StatisticsTimeFrameSchema.optional().default("24h"),
});

const AppStatisticsQuerySchema = StatisticsQuerySchema.merge(
  PaginationQuerySchema,
).merge(createSortingQuerySchema(APP_STATISTICS_SORT_BY));

const SkillStatisticsQuerySchema = StatisticsQuerySchema.merge(
  PaginationQuerySchema,
).merge(createSortingQuerySchema(SKILL_STATISTICS_SORT_BY));

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
    "/api/statistics/apps",
    {
      schema: {
        operationId: RouteId.GetAppStatistics,
        description:
          "Get per-MCP-App cost: what each app cost to build (the LLM spend of the session that authored it) and what it costs to run (its own archestra.llm.complete() calls, plus how often it is opened). Includes an estimated chat-equivalent cost per app, derived from the organization's measured average cost per chat session over the same timeframe — the baseline is returned alongside so the estimate is auditable. Paginated because app cardinality is unbounded. Apps outside the caller's visibility are excluded.",
        tags: ["Statistics"],
        querystring: AppStatisticsQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(AppStatisticsSchema).extend(
            ChatCostBaselineSchema.shape,
          ),
        ),
      },
    },
    async (
      {
        query: { timeframe, limit, offset, sortBy, sortDirection },
        user,
        organizationId,
      },
      reply,
    ) => {
      // App visibility is the same model the Apps page uses: scope on the
      // backing catalog, with an `app:admin` bypass. Reusing it keeps cost
      // reporting from becoming a listing of apps the caller cannot otherwise
      // see.
      const isAppAdmin = await callerIsAppAdmin(user.id, organizationId);
      const accessibleAppIds = isAppAdmin
        ? undefined
        : await AppAccessModel.getUserAccessibleAppIds({
            organizationId,
            userId: user.id,
          });

      return reply.send(
        await StatisticsModel.getAppStatistics({
          timeframe,
          organizationId,
          pagination: { limit, offset },
          sortBy: sortBy ?? "totalCost",
          sortDirection,
          accessibleAppIds,
        }),
      );
    },
  );

  fastify.get(
    "/api/statistics/skills",
    {
      schema: {
        operationId: RouteId.GetSkillStatistics,
        description:
          "Get per-skill cost. `contextTokens` is the skill's own footprint — the tokens its activation blocks added to the model's context, measured when they were injected. The `attributed*` figures are the spend of the turns that then ran with the skill in context, which is shared with everything else in those turns rather than being the skill's bill alone. Paginated; skills outside the caller's scope are excluded.",
        tags: ["Statistics"],
        querystring: SkillStatisticsQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(SkillStatisticsSchema),
        ),
      },
    },
    async (
      {
        query: { timeframe, limit, offset, sortBy, sortDirection },
        user,
        organizationId,
      },
      reply,
    ) => {
      const checker = await getSkillPermissionChecker({
        userId: user.id,
        organizationId,
      });
      const accessibleSkillIds = checker.isAdmin
        ? undefined
        : await SkillTeamModel.getUserAccessibleSkillIds({
            organizationId,
            userId: user.id,
          });

      return reply.send(
        await StatisticsModel.getSkillStatistics({
          timeframe,
          organizationId,
          pagination: { limit, offset },
          sortBy: sortBy ?? "attributedCost",
          sortDirection,
          accessibleSkillIds,
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

import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
  StatisticsTimeFrameSchema,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
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
  MyStatisticsSchema,
  MyUsageBreakdownSchema,
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

/**
 * How many of the caller's costliest sessions the breakdown names.
 *
 * Fixed rather than a query parameter: the point of the list is that agentic
 * spend concentrates in a few sessions, and a page that can be widened to
 * hundreds is a log view — which already exists, filterable, at /llm/logs.
 */
const TOP_SESSION_LIMIT = 8;

const statisticsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/statistics/teams",
    {
      schema: {
        operationId: RouteId.GetTeamStatistics,
        description:
          "Get organization-wide team usage statistics. The result includes every team in the active organization; agent administration permission is not required.",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(z.array(TeamStatisticsSchema)),
      },
    },
    async ({ query: { timeframe }, organizationId }, reply) => {
      return reply.send(
        await StatisticsModel.getTeamStatistics({
          timeframe,
          organizationId,
        }),
      );
    },
  );

  fastify.get(
    "/api/statistics/agents",
    {
      schema: {
        operationId: RouteId.GetAgentStatistics,
        description:
          "Get organization-wide agent usage statistics. The result includes every agent in the active organization; agent administration permission is not required.",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(z.array(AgentStatisticsSchema)),
      },
    },
    async ({ query: { timeframe }, organizationId }, reply) => {
      return reply.send(
        await StatisticsModel.getAgentStatistics({
          timeframe,
          organizationId,
        }),
      );
    },
  );

  fastify.get(
    "/api/statistics/models",
    {
      schema: {
        operationId: RouteId.GetModelStatistics,
        description:
          "Get organization-wide model usage statistics. The result includes every interaction in the active organization; agent administration permission is not required.",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(z.array(ModelStatisticsSchema)),
      },
    },
    async ({ query: { timeframe }, organizationId }, reply) => {
      return reply.send(
        await StatisticsModel.getModelStatistics({
          timeframe,
          organizationId,
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
          "Get organization-wide per-user usage statistics (requests, tokens, cost and model mix), for AI-adoption reporting. Paginated because user cardinality is unbounded. Only traffic that carries a resolved user identity is included; requests authenticated with a shared credential and no user context are not attributed to anyone. Callers without `member:read` see only their own usage.",
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
          organizationId,
          pagination: { limit, offset },
          sortBy: sortBy ?? "totalTokens",
          sortDirection,
          includeTimeSeries,
          includeModels,
          requestingUserId: user.id,
          canReadAllUsers,
        }),
      );
    },
  );

  fastify.get(
    "/api/statistics/me",
    {
      schema: {
        operationId: RouteId.GetMyStatistics,
        description:
          "Get the calling user's own cost and usage for a timeframe: requests, tokens, billed and subscription-covered spend, active days and model mix. Reports only the caller's own activity, so unlike the other statistics endpoints it requires no permission over organization-wide cost data.",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(MyStatisticsSchema),
      },
    },
    async ({ query: { timeframe }, user, organizationId }, reply) =>
      reply.send(
        await StatisticsModel.getMyStatistics({
          timeframe,
          userId: user.id,
          organizationId,
        }),
      ),
  );

  fastify.get(
    "/api/statistics/me/breakdown",
    {
      schema: {
        operationId: RouteId.GetMyUsageBreakdown,
        description:
          "Explain the calling user's own usage: the client applications that generated it, the price band their tokens fell into (fresh input, cache read, cache write, output, plus what caching cost and saved), how their requests were distributed across context sizes, and which of their sessions concentrated the spend. Cost here is list price across both billing modes, because this is a consumption view — a caller on a flat-rate plan has no billed spend to apportion. Reports only the caller's own activity, so like `/api/statistics/me` it requires no permission over organization-wide cost data.",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(MyUsageBreakdownSchema),
      },
    },
    async ({ query: { timeframe }, user, organizationId }, reply) =>
      reply.send(
        await StatisticsModel.getMyUsageBreakdown({
          timeframe,
          userId: user.id,
          organizationId,
          sessionLimit: TOP_SESSION_LIMIT,
        }),
      ),
  );

  fastify.get(
    "/api/statistics/apps",
    {
      schema: {
        operationId: RouteId.GetAppStatistics,
        description:
          "Get per-MCP-App cost: what each app cost to build (the LLM spend of the session that authored it) and what it costs to run (its own archestra.llm.complete() calls, plus how often it is opened). Includes an estimated chat-equivalent cost per app, derived from the organization's measured average cost per chat session over the same timeframe — the baseline is returned alongside so the estimate is auditable. Paginated. Apps outside the caller's visibility are excluded.",
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
          "Get per-skill cost. `contextTokens` is the skill's own footprint — the tokens its activation blocks added to the model's context, measured when they were injected. The `attributed*` figures are the spend of the turns that then ran with the skill in context, which is shared with everything else in those turns rather than being the skill's bill alone — they are computed for the returned page, so they are not a sortable column. Paginated; skills outside the caller's scope are excluded.",
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
          sortBy: sortBy ?? "contextTokens",
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
        description:
          "Get organization-wide usage totals and leaders for the active organization. Agent administration permission is not required.",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(OverviewStatisticsSchema),
      },
    },
    async ({ query: { timeframe }, organizationId }, reply) => {
      return reply.send(
        await StatisticsModel.getOverviewStatistics({
          timeframe,
          organizationId,
        }),
      );
    },
  );

  fastify.get(
    "/api/statistics/cost-savings",
    {
      schema: {
        operationId: RouteId.GetCostSavingsStatistics,
        description:
          "Get organization-wide cost savings statistics for the active organization. Agent administration permission is not required.",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(CostSavingsStatisticsSchema),
      },
    },
    async ({ query: { timeframe }, organizationId }, reply) => {
      return reply.send(
        await StatisticsModel.getCostSavingsStatistics({
          timeframe,
          organizationId,
        }),
      );
    },
  );
};

export default statisticsRoutes;

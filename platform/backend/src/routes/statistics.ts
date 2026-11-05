import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
  StatisticsTimeFrameSchema,
} from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import config from "@/config";
import {
  AppAccessModel,
  SkillTeamModel,
  StatisticsModel,
  UsageStatisticsModel,
} from "@/models";
import { callerIsAppAdmin } from "@/services/apps/app-authorization";
import { getCostAccess } from "@/services/cost-access";
import {
  AgentStatisticsSchema,
  APP_STATISTICS_SORT_BY,
  APP_USAGE_DIMENSIONS,
  ApiError,
  AppStatisticsSchema,
  AppUsageResponseSchema,
  ChatCostBaselineSchema,
  CostSavingsStatisticsSchema,
  CostStatisticsSchema,
  constructResponseSchema,
  createSortingQuerySchema,
  LLM_USAGE_DIMENSIONS,
  LlmUsageResponseSchema,
  MCP_TOOL_CALL_USAGE_DIMENSIONS,
  McpToolCallUsageResponseSchema,
  ModelStatisticsSchema,
  ModelUsageQuerySchema,
  ModelUsageRowSchema,
  MyStatisticsSchema,
  MyUsageBreakdownSchema,
  OverviewStatisticsSchema,
  ProxyCostQuerySchema,
  ProxyCostStatisticsSchema,
  SKILL_STATISTICS_SORT_BY,
  SKILL_USAGE_DIMENSIONS,
  SkillStatisticsSchema,
  SkillUsageResponseSchema,
  TeamStatisticsSchema,
  USER_STATISTICS_SORT_BY,
  UserStatisticsSchema,
} from "@/types";

const StatisticsQuerySchema = z.object({
  timeframe: StatisticsTimeFrameSchema.optional().default("24h"),
});

const TeamCostQuerySchema = StatisticsQuerySchema.extend({
  teamId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Only requests charged to this team: those billed to it or a sub-team, and those its members made through agents shared with it.",
    ),
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
  includeModelTimeSeries: z
    .stringbool()
    .optional()
    .default(false)
    .describe(
      "Include usage time series for each user's models. Implies includeModels. Off by default: it multiplies the response by models and time buckets.",
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
    "/api/statistics/llm-proxy",
    {
      schema: {
        operationId: RouteId.GetProxyCostStatistics,
        description:
          "LLM Proxy usage by authentication method and credential, including legacy proxy profiles. Each request is counted once. Billed spend excludes subscription-covered list-price estimates. Credential details are paginated; totals and time series cover the entire filtered result. Null credential IDs mean unavailable or not applicable; provider secrets are never returned. Callers without `member:read` see only their own usage. With labelKey, also return separately paginated label groups. Labels are captured at request admission: authenticated virtual-key or OAuth-client labels override labels on its billing team. Caller metadata cannot override these labels. Label edits and deletions do not rewrite history; requests without a snapshot value form the null/unassigned group. All totals, trends and groupings apply the same label filters. With includeProviderKeys or includeModelPools, also return usage grouped by the provider key that served each call or the model pool it went through; null groups are calls with no recorded key or no pool. A request a model pool failed over writes one row per attempt: failed attempts count as requests at zero cost and tokens, and failedOverAttempts counts them.",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema.merge(ProxyCostQuerySchema).merge(
          PaginationQuerySchema,
        ),
        response: constructResponseSchema(ProxyCostStatisticsSchema),
      },
    },
    async (request) => {
      const { query, organizationId } = request;
      if ((query.labelValue || query.labelUnassigned) && !query.labelKey)
        throw new ApiError(400, "A label key is required for a label filter");
      if (query.labelValue && query.labelUnassigned)
        throw new ApiError(400, "Choose a label value or unassigned, not both");
      return StatisticsModel.getProxyCostStatistics({
        ...query,
        // Pools are a beta feature; while it is off there is nothing to group.
        includeModelPools:
          query.includeModelPools && config.llmProxy.modelPoolsEnabled,
        organizationId,
        ...(await ownProxyUsageScope(request)),
      });
    },
  );

  fastify.get(
    "/api/statistics/teams",
    {
      schema: {
        operationId: RouteId.GetTeamStatistics,
        description:
          "Get usage statistics for every team in the active organization. A caller without `llmCost:read` who administers a team gets only the teams they administer and their sub-teams; each request then counts for the teams whose spend limits it charges. Filtering by `teamId` does the same for one team.",
        tags: ["Statistics"],
        querystring: TeamCostQuerySchema,
        response: constructResponseSchema(z.array(TeamStatisticsSchema)),
      },
    },
    async (request, reply) => {
      const {
        query: { timeframe, teamId },
        organizationId,
      } = request;
      return reply.send(
        await StatisticsModel.getTeamStatistics({
          timeframe,
          organizationId,
          teamIds: (await getCostAccess(request, teamId)).teamIds,
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
          "Get usage statistics for every agent in the active organization. Callers without `member:read` see only their own usage of each agent.",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(z.array(AgentStatisticsSchema)),
      },
    },
    async (request, reply) => {
      return reply.send(
        await StatisticsModel.getAgentStatistics({
          timeframe: request.query.timeframe,
          organizationId: request.organizationId,
          ...(await ownUsageScope(request)),
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
          "Get model usage statistics for every interaction in the active organization.",
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
          includeModelTimeSeries,
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
          includeModelTimeSeries,
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
          "Get organization-wide usage totals and leaders for the active organization. Agent administration permission is not required. Without `member:read`, the top agent reflects only the caller's own usage, since an agent can be someone's personal one.",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema,
        response: constructResponseSchema(OverviewStatisticsSchema),
      },
    },
    async (request, reply) => {
      return reply.send(
        await StatisticsModel.getOverviewStatistics({
          timeframe: request.query.timeframe,
          organizationId: request.organizationId,
          topAgentScope: await ownUsageScope(request),
        }),
      );
    },
  );

  fastify.get(
    "/api/statistics/costs",
    {
      schema: {
        operationId: RouteId.GetCostStatistics,
        description:
          "Get the Costs overview and model chart from shared aggregates. Active user counts are self-scoped without member:read; no user identities are returned. A caller without `llmCost:read` who administers a team gets only the requests charged to the teams they administer and their sub-teams, with active users counted within them. Filtering by `teamId` does the same for one team.",
        tags: ["Statistics"],
        querystring: TeamCostQuerySchema,
        response: constructResponseSchema(CostStatisticsSchema),
      },
    },
    async (request) => {
      const {
        query: { timeframe, teamId },
        organizationId,
        user,
        headers,
        serviceAccount,
      } = request;
      const { teamIds, teamAdmin } = await getCostAccess(request, teamId);
      // A team admin may count who is active within their own teams.
      const canReadAllUsers =
        teamAdmin ||
        (
          await hasPermission({ member: ["read"] }, headers, serviceAccount, {
            userId: user.id,
            organizationId,
          })
        ).success;
      return StatisticsModel.getCostStatistics({
        timeframe,
        organizationId,
        requestingUserId: user.id,
        canReadAllUsers,
        teamIds,
      });
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

  fastify.get(
    "/api/statistics/mcp-tool-calls",
    {
      schema: {
        operationId: RouteId.GetMcpToolCallUsage,
        description:
          "Get MCP tool-call counts grouped by any combination of `day`, `mcpServerName`, `toolName`, `userId`, `agentId` and `appId` — one row per group, with its call and error counts. Group by `day` (UTC calendar days) for a daily series, e.g. `groupBy=day,toolName`. Counts `tools/call` requests made by agents, gateways and apps. Callers without `member:read` see only their own calls.",
        tags: ["Statistics"],
        querystring: UsageQuerySchema.extend({
          groupBy: groupByQuerySchema(MCP_TOOL_CALL_USAGE_DIMENSIONS, [
            "mcpServerName",
            "toolName",
          ]),
          agentId: z.string().uuid().optional(),
          appId: z.string().uuid().optional(),
          mcpServerName: z.string().min(1).max(255).optional(),
          toolName: z.string().min(1).max(255).optional(),
        }),
        response: constructResponseSchema(McpToolCallUsageResponseSchema),
      },
    },
    async (request, reply) => {
      const {
        query: { limit, offset, ...filters },
        organizationId,
      } = request;
      return reply.send(
        await UsageStatisticsModel.getMcpToolCallUsage({
          ...filters,
          pagination: { limit, offset },
          ...(await usageScope(request)),
          organizationId,
        }),
      );
    },
  );

  fastify.get(
    "/api/statistics/llm-usage",
    {
      schema: {
        operationId: RouteId.GetLlmUsage,
        description:
          "Get LLM requests, tokens and spend grouped by any combination of `day`, `teamId`, `credentialId` (virtual key, passthrough key or OAuth client), `provider` and `model` — one row per group. For example `groupBy=teamId,provider,model` answers which providers and models each team used and what they cost, and `groupBy=day,credentialId` gives a daily series per virtual key. Each dimension is attributed as on its own statistics endpoint: team as in GET /api/statistics/teams, credential as in GET /api/statistics/llm-proxy, model as the billed model of GET /api/statistics/models.",
        tags: ["Statistics"],
        querystring: StatisticsQuerySchema.merge(PaginationQuerySchema).extend({
          groupBy: groupByQuerySchema(LLM_USAGE_DIMENSIONS, [
            "teamId",
            "provider",
            "model",
          ]),
          teamId: z
            .string()
            .min(1)
            .optional()
            .describe("Only this team's usage."),
          credentialId: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Only this virtual key, passthrough key or OAuth client.",
            ),
          provider: z
            .string()
            .min(1)
            .optional()
            .describe("Only this provider, e.g. anthropic."),
          model: z
            .string()
            .min(1)
            .optional()
            .describe("Only this billed model."),
        }),
        response: constructResponseSchema(LlmUsageResponseSchema),
      },
    },
    async ({ query: { limit, offset, ...filters }, organizationId }, reply) => {
      return reply.send(
        await UsageStatisticsModel.getLlmUsage({
          ...filters,
          pagination: { limit, offset },
          organizationId,
        }),
      );
    },
  );

  fastify.get(
    "/api/statistics/app-usage",
    {
      schema: {
        operationId: RouteId.GetAppUsage,
        description:
          "Get app usage grouped by any combination of `day`, `appId` and `userId` — one row per group: times the app was opened, tool calls it made, and the LLM requests, tokens and spend it generated. Group by `day` (UTC calendar days) for a daily series. Apps outside the caller's visibility are excluded, and callers without `member:read` see only their own usage.",
        tags: ["Statistics"],
        querystring: UsageQuerySchema.extend({
          groupBy: groupByQuerySchema(APP_USAGE_DIMENSIONS, ["appId"]),
          appId: z.string().uuid().optional(),
        }),
        response: constructResponseSchema(AppUsageResponseSchema),
      },
    },
    async (request, reply) => {
      const {
        query: { limit, offset, ...filters },
        organizationId,
        user,
      } = request;
      const accessibleAppIds = (await callerIsAppAdmin(user.id, organizationId))
        ? undefined
        : await AppAccessModel.getUserAccessibleAppIds({
            organizationId,
            userId: user.id,
          });
      return reply.send(
        await UsageStatisticsModel.getAppUsage({
          ...filters,
          pagination: { limit, offset },
          ...(await usageScope(request)),
          organizationId,
          accessibleAppIds,
        }),
      );
    },
  );

  fastify.get(
    "/api/statistics/skill-usage",
    {
      schema: {
        operationId: RouteId.GetSkillUsage,
        description:
          "Get skill usage grouped by any combination of `day`, `skillId` and `userId` — one row per group: activations, the context tokens they added, and how many distinct people activated a skill. Group by `day` (UTC calendar days) for a daily series. Covers the organization's own skills. Skills outside the caller's scope are excluded, and callers without `member:read` see only their own usage.",
        tags: ["Statistics"],
        querystring: UsageQuerySchema.extend({
          groupBy: groupByQuerySchema(SKILL_USAGE_DIMENSIONS, ["skillId"]),
          skillId: z.string().uuid().optional(),
        }),
        response: constructResponseSchema(SkillUsageResponseSchema),
      },
    },
    async (request, reply) => {
      const {
        query: { limit, offset, ...filters },
        organizationId,
        user,
      } = request;
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
        await UsageStatisticsModel.getSkillUsage({
          ...filters,
          pagination: { limit, offset },
          ...(await usageScope(request)),
          organizationId,
          accessibleSkillIds,
        }),
      );
    },
  );

  // Preserve existing OpenAPI schema references when registering these new routes.
  for (const own of [false, true]) {
    fastify.get(
      own ? "/api/statistics/me/model-usage" : "/api/statistics/model-usage",
      {
        schema: {
          operationId: own ? RouteId.GetMyModelUsage : RouteId.GetModelUsage,
          description:
            "Break down one model's recorded usage by person, credential, agent or client. Totals and timelines use the same model and timeframe. Unattributed usage remains visible. The personal endpoint always reports only the caller's activity. Callers without `member:read` see only their own usage, since a key or agent can be someone's personal one.",
          tags: ["Statistics"],
          querystring: StatisticsQuerySchema.merge(
            ModelUsageQuerySchema.extend({
              groupBy: ModelUsageQuerySchema.shape.groupBy.default(
                own ? "client" : "person",
              ),
            }),
          ).merge(PaginationQuerySchema),
          response: constructResponseSchema(
            createPaginatedResponseSchema(ModelUsageRowSchema),
          ),
        },
      },
      async (request) => {
        const { query, user, organizationId } = request;
        if (own && query.groupBy !== "client")
          throw new ApiError(
            400,
            "Personal model usage can be grouped by client.",
          );
        return StatisticsModel.getModelUsage({
          ...query,
          organizationId,
          ...(own ? { userId: user.id } : await ownUsageScope(request)),
        });
      },
    );
  }
};

export default statisticsRoutes;

// ===== Internal =====

/** Filters shared by the grouped usage endpoints. */
const UsageQuerySchema = StatisticsQuerySchema.extend({
  userId: z.string().min(1).optional().describe("Only this person's usage."),
  teamId: z
    .string()
    .min(1)
    .optional()
    .describe("Only usage by direct members of this team."),
}).merge(PaginationQuerySchema);

/** A comma-separated `groupBy` list of the endpoint's dimensions. */
function groupByQuerySchema<const D extends readonly [string, ...string[]]>(
  dimensions: D,
  defaultValue: D[number][],
) {
  return z
    .preprocess(
      (value) =>
        typeof value === "string" ? value.split(",").filter(Boolean) : value,
      z.array(z.enum(dimensions)).min(1),
    )
    .optional()
    .default(defaultValue)
    .describe(
      `Comma-separated dimensions to group by: ${dimensions.join(", ")}. Defaults to ${defaultValue.join(",")}.`,
    );
}

/**
 * Seeing other people's usage implies seeing the roster, so — as for
 * per-user statistics — it requires `member:read`; without it the results
 * narrow to the caller's own usage.
 */
async function usageScope({
  user,
  organizationId,
  headers,
  serviceAccount,
}: FastifyRequest): Promise<{ restrictToUserId?: string }> {
  const { success: canReadAllUsers } = await hasPermission(
    { member: ["read"] },
    headers,
    serviceAccount,
    { userId: user.id, organizationId },
  );
  return canReadAllUsers ? {} : { restrictToUserId: user.id };
}

/**
 * Narrows a breakdown to the caller's own usage when they lack `member:read`;
 * empty when they may see everyone's. Breakdowns by agent or credential count
 * here too: an agent or virtual key can be one person's own, and its row would
 * then be that person's spend. A service account's own usage is recorded
 * against the account, not a user, so it is matched by account.
 */
async function ownUsageScope({
  user,
  organizationId,
  headers,
  serviceAccount,
}: FastifyRequest): Promise<{ userId?: string; serviceAccountId?: string }> {
  const { success } = await hasPermission(
    { member: ["read"] },
    headers,
    serviceAccount,
    { userId: user.id, organizationId },
  );
  if (success) return {};
  return serviceAccount
    ? { serviceAccountId: serviceAccount.id }
    : { userId: user.id };
}

/** {@link ownUsageScope}, keeping the proxy query's own `serviceAccountId` filter. */
async function ownProxyUsageScope(
  request: FastifyRequest,
): Promise<{ userId?: string; ownServiceAccountId?: string }> {
  const { userId, serviceAccountId } = await ownUsageScope(request);
  return { userId, ownServiceAccountId: serviceAccountId };
}

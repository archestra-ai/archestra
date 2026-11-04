import {
  ClientFilterSchema,
  CursorQuerySchema,
  createCursorPaginatedResponseSchema,
  createPaginatedResponseSchema,
  InteractionSourceSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import {
  InteractionModel,
  KnowledgeBaseConnectorModel,
  LlmProviderApiKeyModel,
  OpenAppaSessionModel,
  VirtualApiKeyModel,
} from "@/models";
import RoutingDecisionModel from "@/models/routing-decision";
import {
  ApiError,
  constructResponseSchema,
  createSortingQuerySchema,
  InteractionSummarySchema,
  SelectInteractionSchema,
  SessionLineageSchema,
  SessionSummarySchema,
  UserInfoSchema,
  UuidIdSchema,
} from "@/types";
import {
  AutoRoutingTierNameSchema,
  InteractionAutoRoutingResponseSchema,
} from "@/types/auto-routing-api";

const interactionRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const usageFieldGuide =
    "In the response, `inputTokens` and `outputTokens` are recorded token counts; `inputTokensEstimated` identifies a locally estimated input count. `cacheReadTokens` and `cacheWriteTokens` describe provider cache usage. For these counts, `null` means unavailable or not applicable, while `0` is a recorded zero. Counts can be partial if a stream ends early. Open the response's **Schema** tab for field descriptions.";
  const legacyRoutes: Array<Parameters<typeof fastify.route>[0]> = [];
  fastify.addHook("onRoute", (route) => {
    if (route.method === "GET" && route.url.startsWith("/api/llm-proxy-logs")) {
      legacyRoutes.push(route as Parameters<typeof fastify.route>[0]);
    }
  });

  fastify.get(
    "/api/llm-proxy-logs",
    {
      schema: {
        operationId: RouteId.GetLlmProxyLogs,
        description:
          "List LLM Proxy request logs in the active organization with pagination and sorting. `log:read` returns the caller's rows; `log:admin` includes every row in the organization.\n\n" +
          usageFieldGuide,
        tags: ["LLM Proxy Logs"],
        querystring: z
          .object({
            profileId: UuidIdSchema.optional().describe(
              // white-label-ok: OpenAPI prose; branded per request by enrichOpenApiWithRbac (route schemas register before the branding singleton syncs)
              "Filter by profile ID (internal Archestra profile)",
            ),
            externalAgentId: z
              .string()
              .optional()
              .describe(
                "Filter by external agent ID (from X-Archestra-Agent-Id header)",
              ),
            userId: z
              .string()
              .optional()
              .describe("Filter by user ID (from X-Archestra-User-Id header)"),
            sessionId: z
              .string()
              .optional()
              .describe(
                "Filter by session ID. A request logged without a session is a session of its own, addressed by its log ID.",
              ),
            startDate: z
              .string()
              .datetime()
              .optional()
              .describe("Filter by start date (ISO 8601 format)"),
            endDate: z
              .string()
              .datetime()
              .optional()
              .describe("Filter by end date (ISO 8601 format)"),
          })
          .merge(PaginationQuerySchema)
          .merge(
            createSortingQuerySchema([
              "createdAt",
              "profileId",
              "externalAgentId",
              "model",
              "userId",
            ] as const),
          ),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectInteractionSchema),
        ),
      },
    },
    async (
      {
        query: {
          profileId,
          externalAgentId,
          userId,
          sessionId,
          startDate,
          endDate,
          limit,
          offset,
          sortBy,
          sortDirection,
        },
        user,
        organizationId,
      },
      reply,
    ) => {
      const pagination = { limit, offset };
      const sorting = { sortBy, sortDirection };

      // log:read scopes the view to the caller's own attributed rows;
      // log:admin lifts it within the active organization.
      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );

      fastify.log.info(
        {
          userId: user.id,
          email: user.email,
          canSeeAllLogs,
          profileId,
          externalAgentId,
          filterUserId: userId,
          sessionId,
          startDate,
          endDate,
          pagination,
          sorting,
        },
        "GetInteractions request",
      );

      const result = await InteractionModel.findAllPaginated(
        pagination,
        sorting,
        undefined,
        undefined,
        {
          organizationId,
          profileId,
          externalAgentId,
          userId: canSeeAllLogs ? userId : user.id,
          sessionId,
          startDate: startDate ? new Date(startDate) : undefined,
          endDate: endDate ? new Date(endDate) : undefined,
        },
      );

      fastify.log.info(
        {
          resultCount: result.data.length,
          hasNext: result.pagination.hasNext,
        },
        "GetInteractions result",
      );

      return reply.send(result);
    },
  );

  fastify.get(
    "/api/llm-proxy-logs/summaries",
    {
      schema: {
        operationId: RouteId.GetLlmProxyLogSummaries,
        description:
          "List LLM Proxy request log metadata without request and response payloads. `log:read` returns the caller's rows; `log:admin` includes every row in the organization.\n\n" +
          usageFieldGuide,
        tags: ["LLM Proxy Logs"],
        querystring: z
          .object({
            profileId: UuidIdSchema.optional(),
            externalAgentId: z.string().optional(),
            userId: z.string().optional(),
            sessionId: z
              .string()
              .optional()
              .describe(
                "Filter by session ID. A request logged without a session is a session of its own, addressed by its log ID.",
              ),
            startDate: z.string().datetime().optional(),
            endDate: z.string().datetime().optional(),
            beforeId: UuidIdSchema.optional().describe(
              "Only rows created before this log entry, ordered by creation time then ID at the stored precision. Its total is the entry's zero-based position.",
            ),
          })
          .merge(PaginationQuerySchema)
          .merge(
            createSortingQuerySchema([
              "createdAt",
              "profileId",
              "externalAgentId",
              "model",
              "userId",
            ] as const),
          ),
        response: constructResponseSchema(
          createPaginatedResponseSchema(InteractionSummarySchema),
        ),
      },
    },
    async (
      {
        query: {
          profileId,
          externalAgentId,
          userId,
          sessionId,
          startDate,
          endDate,
          beforeId,
          limit,
          offset,
          sortBy,
          sortDirection,
        },
        user,
        organizationId,
      },
      reply,
    ) => {
      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );
      return reply.send(
        await InteractionModel.findSummariesPaginated({
          pagination: { limit, offset },
          sorting: { sortBy, sortDirection },
          filters: {
            organizationId,
            profileId,
            externalAgentId,
            userId: canSeeAllLogs ? userId : user.id,
            sessionId,
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            beforeId,
          },
        }),
      );
    },
  );

  // This route must come before the :logId route so "sessions" is not parsed as a log ID.
  fastify.get(
    "/api/llm-proxy-logs/sessions",
    {
      schema: {
        operationId: RouteId.GetLlmProxyLogSessions,
        description:
          "List LLM Proxy log sessions with aggregated usage and cost. `log:read` returns the caller's sessions; `log:admin` includes every session in the organization.",
        tags: ["LLM Proxy Logs"],
        querystring: z
          .object({
            profileId: UuidIdSchema.optional().describe(
              // white-label-ok: OpenAPI prose; branded per request by enrichOpenApiWithRbac (route schemas register before the branding singleton syncs)
              "Filter by profile ID (internal Archestra profile)",
            ),
            userId: z
              .string()
              .optional()
              .describe("Filter by user ID (from X-Archestra-User-Id header)"),
            source: InteractionSourceSchema.optional().describe(
              "Filter by interaction source",
            ),
            client: ClientFilterSchema.optional().describe(
              "Filter by client app (queries external_agent_id; e.g. claude)",
            ),
            sessionId: z
              .string()
              .optional()
              .describe(
                "Filter by session ID. A request logged without a session is a session of its own, addressed by its log ID.",
              ),
            startDate: z
              .string()
              .datetime()
              .optional()
              .describe("Filter by start date (ISO 8601 format)"),
            endDate: z
              .string()
              .datetime()
              .optional()
              .describe("Filter by end date (ISO 8601 format)"),
          })
          .merge(CursorQuerySchema),
        response: constructResponseSchema(
          createCursorPaginatedResponseSchema(SessionSummarySchema),
        ),
      },
    },
    async (
      {
        query: {
          profileId,
          userId,
          source,
          client,
          sessionId,
          startDate,
          endDate,
          limit,
          cursor,
        },
        user,
        organizationId,
      },
      reply,
    ) => {
      const cursorQuery = { limit, cursor };

      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );

      fastify.log.info(
        {
          userId: user.id,
          email: user.email,
          canSeeAllLogs,
          profileId,
          filterUserId: userId,
          source,
          client,
          sessionId,
          startDate,
          endDate,
          cursorQuery,
        },
        "GetInteractionSessions request",
      );

      const result = await InteractionModel.getSessionsCursor(
        cursorQuery,
        undefined,
        undefined,
        {
          organizationId,
          profileId,
          userId: canSeeAllLogs ? userId : user.id,
          source,
          client,
          sessionId,
          startDate: startDate ? new Date(startDate) : undefined,
          endDate: endDate ? new Date(endDate) : undefined,
        },
      );

      fastify.log.info(
        {
          resultCount: result.data.length,
          hasNext: result.pagination.hasNext,
        },
        "GetInteractionSessions result",
      );

      return reply.send(result);
    },
  );

  fastify.get(
    "/api/llm-proxy-logs/sessions/:sessionId/lineage",
    {
      schema: {
        operationId: RouteId.GetLlmProxyLogSessionLineage,
        description:
          "Get a session's fork lineage: the session it forks and the sessions forked from it. A fork is a new client session that starts from another session's history and guardrail state. `log:read` covers the caller's own sessions. `log:admin` covers all organization sessions when the client session ID identifies one caller. If multiple callers share that session ID, lineage is ambiguous and the request fails.",
        tags: ["LLM Proxy Logs"],
        params: z.object({ sessionId: z.string().min(1).max(1024) }),
        response: constructResponseSchema(SessionLineageSchema),
      },
    },
    async ({ params: { sessionId }, user, organizationId }, reply) => {
      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );
      return reply.send(
        await OpenAppaSessionModel.lineage({
          organizationId,
          clientSessionId: sessionId,
          ...(canSeeAllLogs ? {} : { callerId: `user:${user.id}` }),
        }),
      );
    },
  );

  // This route must come before the :logId route.
  fastify.get(
    "/api/llm-proxy-logs/external-agent-ids",
    {
      schema: {
        operationId: RouteId.GetLlmProxyLogExternalAgentIds,
        description:
          "Get external agent IDs from visible logs in the active organization. `log:read` returns identifiers from the caller's attributed rows; `log:admin` returns identifiers from every row in the organization.",
        tags: ["LLM Proxy Logs"],
        response: constructResponseSchema(
          z.array(
            z.object({
              id: z.string(),
              displayName: z.string(),
            }),
          ),
        ),
      },
    },
    async ({ user, organizationId }, reply) => {
      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );

      const externalAgentIds = await InteractionModel.getUniqueExternalAgentIds(
        {
          ownUserId: canSeeAllLogs ? undefined : user.id,
          organizationId,
        },
      );

      return reply.send(externalAgentIds);
    },
  );

  // This route must come before the :logId route.
  fastify.get(
    "/api/llm-proxy-logs/user-ids",
    {
      schema: {
        operationId: RouteId.GetLlmProxyLogUserIds,
        description:
          "Get users represented in visible logs in the active organization, at most `limit` of them. Without `search` or `ids`, the most active users come first. `search` matches user names; `ids` resolves specific users. `log:read` returns only the caller; `log:admin` returns users from every log in the organization.",
        tags: ["LLM Proxy Logs"],
        querystring: z.object({
          search: z.string().optional(),
          ids: z
            .preprocess(
              (value) => (typeof value === "string" ? value.split(",") : value),
              z.array(z.string().min(1)).max(100),
            )
            .optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        }),
        response: constructResponseSchema(z.array(UserInfoSchema)),
      },
    },
    async ({ user, organizationId, query }, reply) => {
      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );
      if (!canSeeAllLogs) {
        // Own-logs view: the only user to filter by is the caller — anything
        // more would enumerate the org roster through a side door.
        return reply.send([{ id: user.id, name: user.name }]);
      }

      return reply.send(
        await InteractionModel.getUserFilterOptions({
          organizationId,
          search: query.search,
          ids: query.ids,
          limit: query.limit,
        }),
      );
    },
  );

  fastify.get(
    "/api/llm-proxy-logs/:logId/auto-routing",
    {
      schema: {
        operationId: RouteId.GetLlmProxyLogAutoRouting,
        description:
          "Get the saved auto-routing decision for an LLM Proxy log. Null means no decision was retained, not that routing was disabled. Does not re-score the request.",
        tags: ["LLM Proxy Logs"],
        params: z.object({ logId: UuidIdSchema }),
        response: constructResponseSchema(InteractionAutoRoutingResponseSchema),
      },
    },
    async (
      { params: { logId: interactionId }, user, organizationId },
      reply,
    ) => {
      const interaction = await InteractionModel.findAccessMetadata({
        id: interactionId,
        organizationId,
      });
      if (!interaction) throw new ApiError(404, "Interaction not found");
      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );
      if (!canSeeAllLogs && interaction.userId !== user.id) {
        throw new ApiError(404, "Interaction not found");
      }
      const decision = await RoutingDecisionModel.findForInteraction({
        organizationId,
        interactionId,
      });
      return reply.send({
        decision: decision
          ? {
              ...decision,
              tier: AutoRoutingTierNameSchema.parse(
                AutoRoutingTierNameSchema.options[decision.tierIndex],
              ),
            }
          : null,
      });
    },
  );

  fastify.get(
    "/api/llm-proxy-logs/:logId",
    {
      schema: {
        operationId: RouteId.GetLlmProxyLog,
        description:
          "Get an LLM Proxy request log by ID. `log:read` permits a row attributed to the caller; `log:admin` permits any row in the organization.\n\n" +
          usageFieldGuide,
        tags: ["LLM Proxy Logs"],
        params: z.object({
          logId: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectInteractionSchema),
      },
    },
    async (
      { params: { logId: interactionId }, user, organizationId },
      reply,
    ) => {
      const interaction = await InteractionModel.findById({
        id: interactionId,
        organizationId,
      });

      if (!interaction) {
        throw new ApiError(404, "Interaction not found");
      }

      // Own-logs view: a row attributed to someone else (or to nobody — no
      // X-Archestra-User-Id) does not exist for this caller. 404, not 403,
      // so existence is not disclosed.
      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );
      if (!canSeeAllLogs && interaction.userId !== user.id) {
        throw new ApiError(404, "Interaction not found");
      }

      // Enrich knowledge-base interactions with their connector metadata.
      const connector = interaction.connectorId
        ? await KnowledgeBaseConnectorModel.findById(interaction.connectorId)
        : null;

      // Name the virtual key(s) this request authenticated with. `auth_method`
      // alone says only that *a* virtual key was used, which is the least
      // useful half of the answer when per-user attribution is the reason the
      // key exists. Scoped to the caller's organization so a stale id can
      // never surface a name across a tenant boundary.
      const virtualKeys = await VirtualApiKeyModel.findSummariesByIds({
        ids: [
          interaction.virtualKeyId,
          interaction.passthroughVirtualKeyId,
        ].filter((id): id is string => id !== null),
        organizationId,
      });

      const copilotCredentialSource =
        interaction.providerApiKeyId &&
        interaction.type.startsWith("github-copilot:")
          ? ((
              await LlmProviderApiKeyModel.findCopilotCredentialSources([
                interaction.providerApiKeyId,
              ])
            ).get(interaction.providerApiKeyId) ?? null)
          : null;

      return reply.send({
        ...interaction,
        copilotCredentialSource,
        connectorName: connector?.name ?? null,
        virtualKey: interaction.virtualKeyId
          ? (virtualKeys.get(interaction.virtualKeyId) ?? null)
          : null,
        passthroughVirtualKey: interaction.passthroughVirtualKeyId
          ? (virtualKeys.get(interaction.passthroughVirtualKeyId) ?? null)
          : null,
      });
    },
  );

  // Keep the old interaction URLs for existing API clients. Hide these aliases
  // from OpenAPI so new clients use the LLM Proxy Logs paths and operation IDs.
  const legacyOperationIds: Record<string, string> = {
    [RouteId.GetLlmProxyLogs]: RouteId.GetInteractions,
    [RouteId.GetLlmProxyLogSummaries]: RouteId.GetInteractionSummaries,
    [RouteId.GetLlmProxyLogSessions]: RouteId.GetInteractionSessions,
    [RouteId.GetLlmProxyLogSessionLineage]:
      RouteId.GetInteractionSessionLineage,
    [RouteId.GetLlmProxyLogExternalAgentIds]: RouteId.GetUniqueExternalAgentIds,
    [RouteId.GetLlmProxyLogUserIds]: RouteId.GetUniqueUserIds,
    [RouteId.GetLlmProxyLogAutoRouting]: RouteId.GetInteractionAutoRouting,
    [RouteId.GetLlmProxyLog]: RouteId.GetInteraction,
  };
  for (const route of legacyRoutes) {
    fastify.route({
      ...route,
      url: route.url.replace("/api/llm-proxy-logs", "/api/interactions"),
      schema: {
        ...route.schema,
        operationId: legacyOperationIds[route.schema?.operationId ?? ""],
        hide: true,
      },
    });
  }
};

export default interactionRoutes;

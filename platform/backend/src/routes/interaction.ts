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
  VirtualApiKeyModel,
} from "@/models";
import {
  ApiError,
  constructResponseSchema,
  createSortingQuerySchema,
  InteractionSummarySchema,
  SelectInteractionSchema,
  SessionSummarySchema,
  UserInfoSchema,
  UuidIdSchema,
} from "@/types";

const interactionRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/interactions",
    {
      schema: {
        operationId: RouteId.GetInteractions,
        description:
          "Get interactions in the active organization with pagination and sorting. `log:read` returns only the caller's attributed rows; `log:admin` returns every row in the organization. Agent permissions do not change log visibility.",
        tags: ["Interaction"],
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
            sessionId: z.string().optional().describe("Filter by session ID"),
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
    "/api/interactions/summaries",
    {
      schema: {
        operationId: RouteId.GetInteractionSummaries,
        description:
          "Get paginated interaction metadata in the active organization without request and response payloads. `log:read` returns only the caller's attributed rows; `log:admin` returns every row in the organization. Agent permissions do not change log visibility.",
        tags: ["Interaction"],
        querystring: z
          .object({
            profileId: UuidIdSchema.optional(),
            externalAgentId: z.string().optional(),
            userId: z.string().optional(),
            sessionId: z.string().optional(),
            startDate: z.string().datetime().optional(),
            endDate: z.string().datetime().optional(),
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
          },
        }),
      );
    },
  );

  // Note: This specific route must come before the :interactionId param route
  // to prevent Fastify from matching "sessions" as an interactionId
  fastify.get(
    "/api/interactions/sessions",
    {
      schema: {
        operationId: RouteId.GetInteractionSessions,
        description:
          "Get interaction sessions in the active organization, grouped by session ID with aggregated statistics. `log:read` returns only the caller's attributed rows; `log:admin` returns every row in the organization. Agent permissions do not change log visibility.",
        tags: ["Interaction"],
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
            sessionId: z.string().optional().describe("Filter by session ID"),
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

  // Note: This specific route must come before the :interactionId param route
  // to prevent Fastify from matching "external-agent-ids" as an interactionId
  fastify.get(
    "/api/interactions/external-agent-ids",
    {
      schema: {
        operationId: RouteId.GetUniqueExternalAgentIds,
        description:
          "Get external agent IDs from visible logs in the active organization. `log:read` returns identifiers from the caller's attributed rows; `log:admin` returns identifiers from every row in the organization.",
        tags: ["Interaction"],
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

  // Note: This specific route must come before the :interactionId param route
  // to prevent Fastify from matching "user-ids" as an interactionId
  fastify.get(
    "/api/interactions/user-ids",
    {
      schema: {
        operationId: RouteId.GetUniqueUserIds,
        description:
          "Get user IDs represented in visible logs in the active organization. `log:read` returns the caller's identity; `log:admin` returns every represented user in the organization.",
        tags: ["Interaction"],
        response: constructResponseSchema(z.array(UserInfoSchema)),
      },
    },
    async ({ user, organizationId }, reply) => {
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

      const userIds = await InteractionModel.getUniqueUserIds({
        organizationId,
      });

      return reply.send(userIds);
    },
  );

  fastify.get(
    "/api/interactions/:interactionId",
    {
      schema: {
        operationId: RouteId.GetInteraction,
        description:
          "Get an interaction in the active organization by ID. `log:read` returns only a row attributed to the caller; `log:admin` can return any row in the organization. Agent permissions do not change log visibility.",
        tags: ["Interaction"],
        params: z.object({
          interactionId: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectInteractionSchema),
      },
    },
    async ({ params: { interactionId }, user, organizationId }, reply) => {
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

      return reply.send({
        ...interaction,
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
};

export default interactionRoutes;

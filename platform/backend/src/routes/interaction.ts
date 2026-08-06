import {
  ClientFilterSchema,
  createPaginatedResponseSchema,
  InteractionSourceSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission, userHasPermission } from "@/auth";
import { InteractionModel, KnowledgeBaseConnectorModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  createSortingQuerySchema,
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
        description: "Get all interactions with pagination and sorting",
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

      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
      // log:read scopes the view to the caller's own attributed rows;
      // log:admin lifts it (the agent-visibility filter below still applies).
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
          isAgentAdmin,
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
        user.id,
        isAgentAdmin,
        {
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
          total: result.pagination.total,
        },
        "GetInteractions result",
      );

      return reply.send(result);
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
          "Get all interaction sessions grouped by session ID with aggregated stats",
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
          .merge(PaginationQuerySchema),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SessionSummarySchema),
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
          offset,
        },
        user,
        organizationId,
      },
      reply,
    ) => {
      const pagination = { limit, offset };

      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
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
          isAgentAdmin,
          canSeeAllLogs,
          profileId,
          filterUserId: userId,
          source,
          client,
          sessionId,
          startDate,
          endDate,
          pagination,
        },
        "GetInteractionSessions request",
      );

      const result = await InteractionModel.getSessions(
        pagination,
        user.id,
        isAgentAdmin,
        {
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
          total: result.pagination.total,
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
          "Get all unique external agent IDs with display names for filtering (from X-Archestra-Agent-Id header)",
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
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      const canSeeAllLogs = await userHasPermission(
        user.id,
        organizationId,
        "log",
        "admin",
      );

      const externalAgentIds = await InteractionModel.getUniqueExternalAgentIds(
        user.id,
        isAgentAdmin,
        canSeeAllLogs ? undefined : user.id,
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
          "Get all unique user IDs with names for filtering (from X-Archestra-User-Id header)",
        tags: ["Interaction"],
        response: constructResponseSchema(z.array(UserInfoSchema)),
      },
    },
    async ({ user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

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

      const userIds = await InteractionModel.getUniqueUserIds(
        user.id,
        isAgentAdmin,
      );

      return reply.send(userIds);
    },
  );

  fastify.get(
    "/api/interactions/:interactionId",
    {
      schema: {
        operationId: RouteId.GetInteraction,
        description: "Get interaction by ID",
        tags: ["Interaction"],
        params: z.object({
          interactionId: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectInteractionSchema),
      },
    },
    async ({ params: { interactionId }, user, organizationId }, reply) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      const interaction = await InteractionModel.findById(
        interactionId,
        user.id,
        isAgentAdmin,
      );

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

      // `interactions` carries no organization of its own, and findById waives
      // its access check for agent admins — so for a KB interaction, whose
      // profile is always null, the connector is the only thing tying the row to
      // an organization. Treat a connector owned by another one as not found
      // rather than serving the row's payload across the tenant boundary.
      // A connector that no longer exists cannot be placed, and stays readable
      // so its logs survive the connector.
      const connector = interaction.connectorId
        ? await KnowledgeBaseConnectorModel.findById(interaction.connectorId)
        : null;

      if (connector && connector.organizationId !== organizationId) {
        throw new ApiError(404, "Interaction not found");
      }

      return reply.send({
        ...interaction,
        connectorName: connector?.name ?? null,
      });
    },
  );
};

export default interactionRoutes;

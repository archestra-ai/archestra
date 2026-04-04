import {
  createPaginatedResponseSchema,
  InteractionSourceSchema,
  PaginationQuerySchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import { InteractionModel } from "@/models";
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

      fastify.log.info(
        {
          userId: user.id,
          email: user.email,
          isAgentAdmin,
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
          userId,
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
              "Filter by profile ID (internal Archestra profile)",
            ),
            userId: z
              .string()
              .optional()
              .describe("Filter by user ID (from X-Archestra-User-Id header)"),
            source: InteractionSourceSchema.optional().describe(
              "Filter by interaction source",
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
            search: z
              .string()
              .optional()
              .describe(
                "Free-text search across session content (case-insensitive)",
              ),
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
          sessionId,
          startDate,
          endDate,
          search,
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

      fastify.log.info(
        {
          userId: user.id,
          email: user.email,
          isAgentAdmin,
          profileId,
          filterUserId: userId,
          source,
          sessionId,
          startDate,
          endDate,
          search,
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
          userId,
          source,
          sessionId,
          startDate: startDate ? new Date(startDate) : undefined,
          endDate: endDate ? new Date(endDate) : undefined,
          search: search || undefined,
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

      const externalAgentIds = await InteractionModel.getUniqueExternalAgentIds(
        user.id,
        isAgentAdmin,
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

      return reply.send(interaction);
    },
  );
};

export default interactionRoutes;

import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { InteractionModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  createPaginatedResponseSchema,
  createSortingQuerySchema,
  PaginationQuerySchema,
  SelectInteractionSchema,
  UserInfoSchema,
  UuidIdSchema,
} from "@/types";

/**
 * Session summary schema for the sessions endpoint
 */
const ToonSkipReasonCountsSchema = z.object({
  applied: z.number(),
  notEnabled: z.number(),
  notEffective: z.number(),
  noToolResults: z.number(),
});

const SessionSummarySchema = z.object({
  sessionId: z.string().nullable(),
  sessionSource: z.string().nullable(),
  interactionId: z.string().nullable(), // Only set for single interactions (null session)
  requestCount: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCost: z.string().nullable(),
  totalBaselineCost: z.string().nullable(),
  totalToonCostSavings: z.string().nullable(),
  toonSkipReasonCounts: ToonSkipReasonCountsSchema,
  firstRequestTime: z.date(),
  lastRequestTime: z.date(),
  models: z.array(z.string()),
  profileId: z.string(),
  profileName: z.string().nullable(),
  externalAgentIds: z.array(z.string()),
  externalAgentIdLabels: z.array(z.string().nullable()), // Resolved prompt names
  userNames: z.array(z.string()),
  lastInteractionRequest: z.unknown().nullable(),
  lastInteractionType: z.string().nullable(),
  conversationTitle: z.string().nullable(),
  claudeCodeTitle: z.string().nullable(),
});

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
        headers,
      },
      reply,
    ) => {
      const pagination = { limit, offset };
      const sorting = { sortBy, sortDirection };

      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

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
          sessionId,
          startDate,
          endDate,
          search,
          limit,
          offset,
        },
        user,
        headers,
      },
      reply,
    ) => {
      const pagination = { limit, offset };

      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      fastify.log.info(
        {
          userId: user.id,
          email: user.email,
          isAgentAdmin,
          profileId,
          filterUserId: userId,
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
    async ({ user, headers }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

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
    async ({ user, headers }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

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
    async ({ params: { interactionId }, user, headers }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

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

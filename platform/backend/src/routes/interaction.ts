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
        { profileId, externalAgentId, userId },
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
  // to prevent Fastify from matching "external-agent-ids" as an interactionId
  fastify.get(
    "/api/interactions/external-agent-ids",
    {
      schema: {
        operationId: RouteId.GetUniqueExternalAgentIds,
        description:
          "Get all unique external agent IDs for filtering (from X-Archestra-Agent-Id header)",
        tags: ["Interaction"],
        response: constructResponseSchema(z.array(z.string())),
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

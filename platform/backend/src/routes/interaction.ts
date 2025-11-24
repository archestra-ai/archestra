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
            agentId: UuidIdSchema.optional().describe("Filter by agent ID"),
          })
          .merge(PaginationQuerySchema)
          .merge(
            createSortingQuerySchema([
              "createdAt",
              "agentId",
              "model",
            ] as const),
          ),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectInteractionSchema),
        ),
      },
    },
    async (
      {
        query: { agentId, limit, offset, sortBy, sortDirection },
        user,
        headers,
      },
      reply,
    ) => {
      const pagination = { limit, offset };
      const sorting = { sortBy, sortDirection };

      if (agentId) {
        return reply.send(
          await InteractionModel.getAllInteractionsForAgentPaginated(
            agentId,
            pagination,
            sorting,
          ),
        );
      }

      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      fastify.log.info(
        {
          userId: user.id,
          email: user.email,
          isAgentAdmin,
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

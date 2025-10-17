import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { InteractionModel } from "@/models";
import {
  createPaginatedResponseSchema,
  createSortingQuerySchema,
  ErrorResponseSchema,
  PaginationQuerySchema,
  RouteId,
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
        response: {
          200: createPaginatedResponseSchema(SelectInteractionSchema),
        },
      },
    },
    async (
      { query: { agentId, limit, offset, sortBy, sortDirection } },
      reply,
    ) => {
      const pagination = { limit, offset };
      const sorting = { sortBy, sortDirection };

      if (agentId) {
        const result =
          await InteractionModel.getAllInteractionsForAgentPaginated(
            agentId,
            pagination,
            sorting,
          );
        return reply.send(result);
      }

      const result = await InteractionModel.findAllPaginated(
        pagination,
        sorting,
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
        response: {
          200: SelectInteractionSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { interactionId } }, reply) => {
      const interaction = await InteractionModel.findById(interactionId);

      if (!interaction) {
        return reply.status(404).send({
          error: {
            message: "Interaction not found",
            type: "not_found",
          },
        });
      }

      return reply.send(interaction);
    },
  );
};

export default interactionRoutes;

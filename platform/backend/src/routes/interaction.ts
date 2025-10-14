import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { InteractionModel } from "@/models";
import {
  createPaginatedResponseSchema,
  ErrorResponseSchema,
  PaginationQuerySchema,
  SelectInteractionSchema,
  UuidIdSchema,
} from "@/types";

const interactionRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/interactions",
    {
      schema: {
        operationId: "getInteractions",
        description: "Get all interactions with optional pagination",
        tags: ["Interaction"],
        querystring: z
          .object({
            agentId: UuidIdSchema.optional().describe("Filter by agent ID"),
          })
          .merge(PaginationQuerySchema),
        response: {
          200: createPaginatedResponseSchema(SelectInteractionSchema),
        },
      },
    },
    async ({ query: { agentId, limit, offset } }, reply) => {
      const pagination = { limit, offset };

      if (agentId) {
        const result =
          await InteractionModel.getAllInteractionsForAgentPaginated(
            agentId,
            pagination,
          );
        return reply.send(result);
      }

      const result = await InteractionModel.findAllPaginated(pagination);
      return reply.send(result);
    },
  );

  fastify.get(
    "/api/interactions/:interactionId",
    {
      schema: {
        operationId: "getInteraction",
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

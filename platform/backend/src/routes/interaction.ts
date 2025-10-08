import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { InteractionModel } from "@/models";
import type { Interaction } from "@/types";
import {
  ErrorResponseSchema,
  SelectInteractionSchema,
  UuidIdSchema,
} from "@/types";

const interactionRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/interactions",
    {
      schema: {
        operationId: "getInteractions",
        description: "Get all interactions",
        tags: ["Interaction"],
        querystring: z.object({
          agentId: UuidIdSchema.optional().describe("Filter by agent ID"),
        }),
        response: {
          200: z.array(SelectInteractionSchema),
        },
      },
    },
    async ({ query: { agentId } }, reply) => {
      let interactions: Interaction[];
      if (agentId) {
        interactions =
          await InteractionModel.getAllInteractionsForAgent(agentId);
      } else {
        interactions = await InteractionModel.findAll();
      }

      return reply.send(interactions);
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

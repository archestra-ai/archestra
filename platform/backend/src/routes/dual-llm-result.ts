import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getUserFromRequest } from "@/auth/utils";
import { DualLlmResultModel, InteractionModel } from "@/models";
import {
  ErrorResponseSchema,
  RouteId,
  SelectDualLlmResultSchema,
  UuidIdSchema,
} from "@/types";

const dualLlmResultRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Get dual LLM result by tool call ID
  fastify.get(
    "/api/dual-llm-results/by-tool-call-id/:toolCallId",
    {
      schema: {
        operationId: RouteId.GetDualLlmResultByToolCallId,
        description: "Get dual LLM result by tool call ID",
        tags: ["Dual LLM Results"],
        params: z.object({
          toolCallId: z.string(),
        }),
        response: {
          200: SelectDualLlmResultSchema.nullable(),
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { toolCallId } }, reply) => {
      try {
        const result = await DualLlmResultModel.findByToolCallId(toolCallId);
        return reply.send(result);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );

  // Get all dual LLM results for an interaction
  fastify.get(
    "/api/dual-llm-results/by-interaction/:interactionId",
    {
      schema: {
        operationId: RouteId.GetDualLlmResultsByInteraction,
        description: "Get all dual LLM results for an interaction",
        tags: ["Dual LLM Results"],
        params: z.object({
          interactionId: UuidIdSchema,
        }),
        response: {
          200: z.array(SelectDualLlmResultSchema),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        // Get the interaction with access control
        const interaction = await InteractionModel.findById(
          request.params.interactionId,
          user.id,
          user.isAdmin,
        );
        if (!interaction) {
          return reply.status(404).send({
            error: {
              message: "Interaction not found",
              type: "not_found",
            },
          });
        }

        if (interaction.type === "openai:chatCompletions") {
          // Extract all tool_call_ids from the interaction messages
          const toolCallIds: string[] = [];
          for (const message of interaction.request.messages) {
            if (message.role === "tool") {
              toolCallIds.push(message.tool_call_id);
            }
          }

          // Fetch dual LLM results for all tool call IDs
          const results = await Promise.all(
            toolCallIds.map((id) => DualLlmResultModel.findByToolCallId(id)),
          );

          // Filter out null results
          const validResults = results.filter(
            (result): result is NonNullable<typeof result> => result !== null,
          );

          return reply.send(validResults);
        }

        if (interaction.type === "anthropic:messages") {
          // Extract all tool_use_ids from the interaction messages
          const toolUseIds: string[] = [];
          for (const message of interaction.request.messages) {
            if (
              message.role === "user" &&
              Array.isArray(message.content) &&
              message.content.length > 0
            ) {
              for (const contentBlock of message.content) {
                if (
                  contentBlock.type === "tool_result" &&
                  "tool_use_id" in contentBlock
                ) {
                  toolUseIds.push(contentBlock.tool_use_id);
                }
              }
            }
          }

          // Fetch dual LLM results for all tool use IDs
          const results = await Promise.all(
            toolUseIds.map((id) => DualLlmResultModel.findByToolCallId(id)),
          );

          // Filter out null results
          const validResults = results.filter(
            (result): result is NonNullable<typeof result> => result !== null,
          );

          return reply.send(validResults);
        }

        // For other interaction types (e.g., Gemini), return empty array for now
        return reply.send([]);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );
};

export default dualLlmResultRoutes;

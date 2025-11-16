import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { DualLlmResultModel, InteractionModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  SelectDualLlmResultSchema,
  UuidIdSchema,
} from "@/types";

const dualLlmResultRoutes: FastifyPluginAsyncZod = async (fastify) => {
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
        response: constructResponseSchema(SelectDualLlmResultSchema.nullable()),
      },
    },
    async ({ params: { toolCallId } }, reply) => {
      return reply.send(await DualLlmResultModel.findByToolCallId(toolCallId));
    },
  );

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
        response: constructResponseSchema(z.array(SelectDualLlmResultSchema)),
      },
    },
    async ({ params: { interactionId }, user, headers }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      // Get the interaction with access control
      const interaction = await InteractionModel.findById(
        interactionId,
        user.id,
        isAgentAdmin,
      );
      if (!interaction) {
        throw new ApiError(404, "Interaction not found");
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
    },
  );
};

export default dualLlmResultRoutes;

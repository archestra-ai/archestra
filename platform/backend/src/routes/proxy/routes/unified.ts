import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { constructResponseSchema, OpenAi, UuidIdSchema } from "@/types";
import { unifiedAdapterFactory } from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";

const unifiedProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const UNIFIED_PREFIX = `${PROXY_API_PREFIX}/unified`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering aggregated unified routes");

  /**
   * Unified Chat Completions (OpenAI-compatible)
   * Uses default agent
   */
  fastify.post(
    `${UNIFIED_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: "unifiedChatCompletionsWithDefaultAgent",
        description: "Unified endpoint for chat completions (OpenAI-compatible)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.ChatCompletionResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling unified request (default agent)",
      );
      return await handleLLMProxy(
        request.body,
        request,
        reply,
        unifiedAdapterFactory
      );
    },
  );

  /**
   * Unified Chat Completions (OpenAI-compatible)
   * Uses specific agentId
   */
  fastify.post(
    `${UNIFIED_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: "unifiedChatCompletionsWithAgent",
        description: "Unified endpoint for chat completions for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.ChatCompletionResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId, model: (request.body as any).model },
        "[UnifiedProxy] Handling unified request (with agent)"
      );
      return await handleLLMProxy(
        request.body,
        request,
        reply,
        unifiedAdapterFactory
      );
    }
  );
};

export default unifiedProxyRoutes;

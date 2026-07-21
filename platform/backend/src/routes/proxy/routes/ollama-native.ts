/**
 * Ollama Native Proxy Routes (`/api/chat`).
 *
 * The `ollama-native` provider talks to Ollama's first-class `/api/chat` endpoint
 * so Archestra can send/display `num_ctx`, `num_predict`, `top_k`, `think`, etc.
 * that the OpenAI-compatible `/v1` endpoint discards. Requests flow through the
 * instrumented `handleLLMProxy` (policies, logging, usage) exactly like every
 * other chat provider.
 *
 * This lives alongside — and does not touch — the OpenAI-compatible `ollama`
 * provider (`./ollama.ts`), which stays the default for existing clients.
 */
import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, OllamaNative, UuidIdSchema } from "@/types";
import { ollamaNativeAdapterFactory } from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";

const NOT_CONFIGURED_ERROR = {
  error: {
    message:
      "Ollama Native provider is not configured. Set ARCHESTRA_OLLAMA_NATIVE_BASE_URL (or ARCHESTRA_OLLAMA_BASE_URL) to enable.",
    type: "api_internal_server_error" as const,
  },
};

const ollamaNativeProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/ollama-native`;
  const CHAT_SUFFIX = "/api/chat";

  logger.info("[UnifiedProxy] Registering Ollama Native routes");

  fastify.post(
    `${API_PREFIX}${CHAT_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OllamaNativeChatWithDefaultAgent,
        description:
          "Create a chat completion with Ollama native /api/chat (uses default agent)",
        tags: ["LLM Proxy"],
        body: OllamaNative.API.ChatRequestSchema,
        headers: OllamaNative.API.ChatHeadersSchema,
        response: constructResponseSchema(OllamaNative.API.ChatResponseSchema),
      },
    },
    async (request, reply) => {
      if (!config.llm["ollama-native"].enabled) {
        return reply.status(500).send(NOT_CONFIGURED_ERROR);
      }
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Ollama native request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        ollamaNativeAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OllamaNativeChatWithAgent,
        description:
          "Create a chat completion with Ollama native /api/chat for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({ agentId: UuidIdSchema }),
        body: OllamaNative.API.ChatRequestSchema,
        headers: OllamaNative.API.ChatHeadersSchema,
        response: constructResponseSchema(OllamaNative.API.ChatResponseSchema),
      },
    },
    async (request, reply) => {
      if (!config.llm["ollama-native"].enabled) {
        return reply.status(500).send(NOT_CONFIGURED_ERROR);
      }
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Ollama native request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        ollamaNativeAdapterFactory,
      );
    },
  );
};

export default ollamaNativeProxyRoutes;

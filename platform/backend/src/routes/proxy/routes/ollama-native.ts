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
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, OllamaNative, UuidIdSchema } from "@/types";
import { ollamaNativeAdapterFactory } from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const ollamaNativeProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/ollama-native`;
  const CHAT_SUFFIX = "/api/chat";

  logger.info("[UnifiedProxy] Registering Ollama Native routes");

  // Pass every non-chat native endpoint (`/api/tags`, `/api/show`, `/api/embed`,
  // `/api/ps`, …) straight through. Without this only `/api/chat` existed, so
  // the Ollama CLI, n8n's Ollama node and anything else that does discovery
  // 404'd against the provider they most want to use. `/api/chat` itself stays
  // on the instrumented handler below (policies, logging, usage).
  // `enabled` is a literal `true` and `baseUrl` always resolves (it defaults to
  // the local Ollama), so there is no not-configured state to guard on.
  const upstream = config.llm["ollama-native"].baseUrl as string;
  await fastify.register(fastifyHttpProxy, {
    upstream,
    prefix: API_PREFIX,
    rewritePrefix: "",
    // No `/v1` rewriting here, unlike the OpenAI-compatible sibling: the
    // native API is served from the server root, so stripping the agent UUID
    // is the whole job.
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_SUFFIX,
      upstream,
      providerName: "Ollama native",
      skipErrorResponse: {
        error: {
          message: "Chat requests should use the dedicated endpoint",
          type: "invalid_request_error",
        },
      },
    }),
  });

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

/**
 * vLLM Proxy Routes
 *
 * vLLM exposes an OpenAI-compatible API, so these routes mirror the OpenAI routes.
 * See: https://docs.vllm.ai/en/latest/features/openai_api.html
 */

import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, OpenAi, UuidIdSchema, Vllm } from "@/types";
import {
  makeOpenAiCompatibleEmbeddingsAdapterFactory,
  vllmAdapterFactory,
} from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const vllmEmbeddingsAdapterFactory =
  makeOpenAiCompatibleEmbeddingsAdapterFactory(
    "vllm",
    () => config.llm.vllm.baseUrl,
  );

const vllmProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/vllm`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
  const EMBEDDINGS_SUFFIX = "/embeddings";

  logger.info("[UnifiedProxy] Registering unified vLLM routes");

  // Only register HTTP proxy if vLLM is configured (has baseUrl)
  // Routes are always registered for OpenAPI schema generation
  if (config.llm.vllm.enabled) {
    await fastify.register(fastifyHttpProxy, {
      upstream: config.llm.vllm.baseUrl as string,
      prefix: API_PREFIX,
      rewritePrefix: "",
      preHandler: createProxyPreHandler({
        apiPrefix: API_PREFIX,
        endpointSuffix: [CHAT_COMPLETIONS_SUFFIX, EMBEDDINGS_SUFFIX],
        upstream: config.llm.vllm.baseUrl as string,
        providerName: "vLLM",
      }),
    });
  } else {
    logger.info(
      "[UnifiedProxy] vLLM base URL not configured, HTTP proxy disabled",
    );
  }

  fastify.post(
    `${API_PREFIX}${EMBEDDINGS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.VllmEmbeddingsWithDefaultAgent,
        description: "Create embeddings with vLLM (uses default agent)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.EmbeddingRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.EmbeddingResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling vLLM embeddings request (default agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.EmbeddingRequest,
        request,
        reply,
        vllmEmbeddingsAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${EMBEDDINGS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.VllmEmbeddingsWithAgent,
        description: "Create embeddings with vLLM for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.EmbeddingRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.EmbeddingResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling vLLM embeddings request (with agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.EmbeddingRequest,
        request,
        reply,
        vllmEmbeddingsAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.VllmChatCompletionsWithDefaultAgent,
        description: "Create a chat completion with vLLM (uses default agent)",
        tags: ["LLM Proxy"],
        body: Vllm.API.ChatCompletionRequestSchema,
        headers: Vllm.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Vllm.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling vLLM request (default agent)",
      );
      return handleLLMProxy(request.body, request, reply, vllmAdapterFactory);
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.VllmChatCompletionsWithAgent,
        description: "Create a chat completion with vLLM for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Vllm.API.ChatCompletionRequestSchema,
        headers: Vllm.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Vllm.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling vLLM request (with agent)",
      );
      return handleLLMProxy(request.body, request, reply, vllmAdapterFactory);
    },
  );
};

export default vllmProxyRoutes;

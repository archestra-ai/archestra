/**
 * Mistral LLM Proxy Routes - OpenAI-compatible
 *
 * Mistral uses an OpenAI-compatible API at https://api.mistral.ai/v1
 * This module registers proxy routes for Mistral chat completions.
 *
 * @see https://docs.mistral.ai/api
 */

import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import {
  constructResponseSchema,
  Mistral,
  OpenAi,
  UuidIdSchema,
} from "@/types";
import {
  makeOpenAiCompatibleEmbeddingsAdapterFactory,
  mistralAdapterFactory,
} from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const mistralEmbeddingsAdapterFactory =
  makeOpenAiCompatibleEmbeddingsAdapterFactory(
    "mistral",
    () => config.llm.mistral.baseUrl,
  );

const mistralProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/mistral`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
  const EMBEDDINGS_SUFFIX = "/embeddings";

  logger.info("[UnifiedProxy] Registering unified Mistral routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.mistral.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: [CHAT_COMPLETIONS_SUFFIX, EMBEDDINGS_SUFFIX],
      upstream: config.llm.mistral.baseUrl,
      providerName: "Mistral",
    }),
  });

  /**
   * Embeddings with default agent
   */
  fastify.post(
    `${API_PREFIX}${EMBEDDINGS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.MistralEmbeddingsWithDefaultAgent,
        description: "Create embeddings with Mistral (uses default agent)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.EmbeddingRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.EmbeddingResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Mistral embeddings request (default agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.EmbeddingRequest,
        request,
        reply,
        mistralEmbeddingsAdapterFactory,
      );
    },
  );

  /**
   * Embeddings with specific agent
   */
  fastify.post(
    `${API_PREFIX}/:agentId${EMBEDDINGS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.MistralEmbeddingsWithAgent,
        description: "Create embeddings with Mistral for a specific agent",
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
        "[UnifiedProxy] Handling Mistral embeddings request (with agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.EmbeddingRequest,
        request,
        reply,
        mistralEmbeddingsAdapterFactory,
      );
    },
  );

  /**
   * Chat completions with default agent
   */
  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.MistralChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with Mistral (uses default agent)",
        tags: ["LLM Proxy"],
        body: Mistral.API.ChatCompletionRequestSchema,
        headers: Mistral.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Mistral.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Mistral request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        mistralAdapterFactory,
      );
    },
  );

  /**
   * Chat completions with specific agent
   */
  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.MistralChatCompletionsWithAgent,
        description:
          "Create a chat completion with Mistral for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Mistral.API.ChatCompletionRequestSchema,
        headers: Mistral.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Mistral.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Mistral request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        mistralAdapterFactory,
      );
    },
  );
};

export default mistralProxyRoutes;

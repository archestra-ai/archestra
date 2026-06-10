import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { fetchOpenAiModels } from "@/routes/chat/model-fetchers/openai";
import { constructResponseSchema, OpenAi, UuidIdSchema } from "@/types";
import {
  openAiEmbeddingsAdapterFactory,
  openAiResponsesAdapterFactory,
  openaiAdapterFactory,
} from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import {
  extractBearerToken,
  OpenAiModelsHeadersSchema,
  OpenAiModelsListResponseSchema,
  resolveProxyModelsApiKey,
  toOpenAiModelsList,
} from "./proxy-model-listing";
import { createProxyPreHandler } from "./proxy-prehandler";

const openAiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/openai`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
  const RESPONSES_SUFFIX = "/responses";
  const EMBEDDINGS_SUFFIX = "/embeddings";

  logger.info("[UnifiedProxy] Registering unified OpenAI routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.openai.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: [
        CHAT_COMPLETIONS_SUFFIX,
        RESPONSES_SUFFIX,
        EMBEDDINGS_SUFFIX,
      ],
      upstream: config.llm.openai.baseUrl,
      providerName: "OpenAI",
    }),
  });

  fastify.post(
    `${API_PREFIX}${EMBEDDINGS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiEmbeddingsWithDefaultAgent,
        description: "Create embeddings with OpenAI (uses default agent)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.EmbeddingRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.EmbeddingResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling OpenAI embeddings request (default agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.EmbeddingRequest,
        request,
        reply,
        openAiEmbeddingsAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${EMBEDDINGS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiEmbeddingsWithAgent,
        description: "Create embeddings with OpenAI for a specific agent",
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
        "[UnifiedProxy] Handling OpenAI embeddings request (with agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.EmbeddingRequest,
        request,
        reply,
        openAiEmbeddingsAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiResponsesWithDefaultAgent,
        description: "Create a response with OpenAI (uses default agent)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.ResponsesRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.ResponsesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling OpenAI responses request (default agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.ResponsesRequest,
        request,
        reply,
        openAiResponsesAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiResponsesWithAgent,
        description: "Create a response with OpenAI for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.ResponsesRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.ResponsesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling OpenAI responses request (with agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.ResponsesRequest,
        request,
        reply,
        openAiResponsesAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with OpenAI (uses default agent)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenAi.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling OpenAI request (default agent)",
      );
      return handleLLMProxy(request.body, request, reply, openaiAdapterFactory);
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiChatCompletionsWithAgent,
        description:
          "Create a chat completion with OpenAI for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenAi.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling OpenAI request (with agent)",
      );
      return handleLLMProxy(request.body, request, reply, openaiAdapterFactory);
    },
  );

  /**
   * Lists OpenAI models for a virtual or raw key. A dedicated route is needed
   * so it takes precedence over this prefix's catch-all http-proxy, which
   * would otherwise forward an `arch_*` key to api.openai.com unresolved and
   * 401. Returns OpenAI's native models shape.
   */
  async function handleListModels(
    request: FastifyRequest,
    agentId: string | undefined,
  ) {
    const { apiKey, baseUrl, extraHeaders } = await resolveProxyModelsApiKey({
      request,
      provider: "openai",
      token: extractBearerToken(request.headers.authorization),
    });
    logger.debug({ agentId }, "[UnifiedProxy] Listing OpenAI models");
    return toOpenAiModelsList(
      await fetchOpenAiModels(apiKey, baseUrl, extraHeaders),
    );
  }

  fastify.get(
    `${API_PREFIX}/models`,
    {
      schema: {
        operationId: RouteId.OpenAiListModelsWithDefaultAgent,
        description: "List OpenAI models (default agent)",
        tags: ["LLM Proxy"],
        headers: OpenAiModelsHeadersSchema,
        response: constructResponseSchema(OpenAiModelsListResponseSchema),
      },
    },
    async (request) => handleListModels(request, undefined),
  );

  fastify.get(
    `${API_PREFIX}/:agentId/models`,
    {
      schema: {
        operationId: RouteId.OpenAiListModelsWithAgent,
        description: "List OpenAI models (specific agent)",
        tags: ["LLM Proxy"],
        params: z.object({ agentId: UuidIdSchema }),
        headers: OpenAiModelsHeadersSchema,
        response: constructResponseSchema(OpenAiModelsListResponseSchema),
      },
    },
    async (request) => handleListModels(request, request.params.agentId),
  );
};

export default openAiProxyRoutes;

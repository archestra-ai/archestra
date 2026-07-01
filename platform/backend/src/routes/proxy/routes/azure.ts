/**
 * Azure AI Foundry LLM Proxy Routes - OpenAI-compatible
 *
 * Azure AI Foundry uses an OpenAI-compatible API at your deployment endpoint.
 */

import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { Azure, constructResponseSchema, OpenAi, UuidIdSchema } from "@/types";
import {
  azureAdapterFactory,
  azureResponsesAdapterFactory,
  makeOpenAiCompatibleEmbeddingsAdapterFactory,
} from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const azureEmbeddingsAdapterFactory =
  makeOpenAiCompatibleEmbeddingsAdapterFactory(
    "azure",
    () => config.llm.azure.baseUrl || undefined,
  );

const azureProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/azure`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
  const RESPONSES_SUFFIX = "/responses";
  const EMBEDDINGS_SUFFIX = "/embeddings";

  logger.info("[UnifiedProxy] Registering unified Azure AI Foundry routes");

  if (config.llm.azure.baseUrl) {
    await fastify.register(fastifyHttpProxy, {
      upstream: config.llm.azure.baseUrl,
      prefix: API_PREFIX,
      rewritePrefix: "",
      preHandler: createProxyPreHandler({
        apiPrefix: API_PREFIX,
        endpointSuffix: [
          CHAT_COMPLETIONS_SUFFIX,
          RESPONSES_SUFFIX,
          EMBEDDINGS_SUFFIX,
        ],
        upstream: config.llm.azure.baseUrl,
        providerName: "Azure AI Foundry",
      }),
    });
  }

  fastify.post(
    `${API_PREFIX}${EMBEDDINGS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.AzureEmbeddingsWithDefaultAgent,
        description:
          "Create embeddings with Azure AI Foundry (uses default agent)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.EmbeddingRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.EmbeddingResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Azure AI Foundry embeddings request (default agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.EmbeddingRequest,
        request,
        reply,
        azureEmbeddingsAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${EMBEDDINGS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.AzureEmbeddingsWithAgent,
        description:
          "Create embeddings with Azure AI Foundry for a specific agent",
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
        "[UnifiedProxy] Handling Azure AI Foundry embeddings request (with agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.EmbeddingRequest,
        request,
        reply,
        azureEmbeddingsAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.AzureChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with Azure AI Foundry (uses default agent)",
        tags: ["LLM Proxy"],
        body: Azure.API.ChatCompletionRequestSchema,
        headers: Azure.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Azure.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Azure AI Foundry request (default agent)",
      );
      return handleLLMProxy(request.body, request, reply, azureAdapterFactory);
    },
  );

  fastify.post(
    `${API_PREFIX}${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.AzureResponsesWithDefaultAgent,
        description:
          "Create a response with Azure AI Foundry (uses default agent)",
        tags: ["LLM Proxy"],
        body: Azure.API.ResponsesRequestSchema,
        headers: Azure.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(Azure.API.ResponsesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Azure AI Foundry responses request (default agent)",
      );
      return handleLLMProxy(
        request.body as Azure.Types.ResponsesRequest,
        request,
        reply,
        azureResponsesAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.AzureResponsesWithAgent,
        description:
          "Create a response with Azure AI Foundry for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Azure.API.ResponsesRequestSchema,
        headers: Azure.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(Azure.API.ResponsesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Azure AI Foundry responses request (with agent)",
      );
      return handleLLMProxy(
        request.body as Azure.Types.ResponsesRequest,
        request,
        reply,
        azureResponsesAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.AzureChatCompletionsWithAgent,
        description:
          "Create a chat completion with Azure AI Foundry for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Azure.API.ChatCompletionRequestSchema,
        headers: Azure.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Azure.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Azure AI Foundry request (with agent)",
      );
      return handleLLMProxy(request.body, request, reply, azureAdapterFactory);
    },
  );
};

export default azureProxyRoutes;

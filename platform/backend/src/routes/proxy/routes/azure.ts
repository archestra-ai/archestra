/**
 * Azure AI Foundry LLM Proxy Routes - OpenAI-compatible
 *
 * Azure AI Foundry uses an OpenAI-compatible API at your deployment endpoint.
 */

import { getAzureModelKind, RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import {
  ApiError,
  Azure,
  constructResponseSchema,
  OpenAi,
  UuidIdSchema,
} from "@/types";
import { azureAdapterFactory, azureResponsesAdapterFactory } from "../adapters";
import { azureEmbeddingsAdapterFactory } from "../adapters/azure";
import { azureImagesAdapterFactory } from "../adapters/azure-images";
import { azureRealtimeAdapterFactory } from "../adapters/azure-realtime";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { createPassthroughAuthenticator } from "../llm-proxy-auth";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const azureProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/azure`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
  const RESPONSES_SUFFIX = "/responses";
  const EMBEDDINGS_SUFFIX = "/embeddings";
  const IMAGES_SUFFIX = "/images/generations";

  logger.debug("[UnifiedProxy] Registering unified Azure AI Foundry routes");

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
          IMAGES_SUFFIX,
          "/realtime/turns",
        ],
        upstream: config.llm.azure.baseUrl,
        providerName: "Azure AI Foundry",
        authenticate: createPassthroughAuthenticator("azure"),
        rejectUnhandledPaths: true,
      }),
    });
  }

  for (const withAgent of [false, true]) {
    fastify.post(
      `${API_PREFIX}${withAgent ? "/:agentId" : ""}/realtime/turns`,
      {
        bodyLimit: PROXY_BODY_LIMIT,
        schema: {
          operationId: withAgent
            ? RouteId.AzureRealtimeTurnWithAgent
            : RouteId.AzureRealtimeTurnWithDefaultAgent,
          description:
            "Create a bounded realtime audio or translation turn through Azure native Realtime WebSockets. Returns Chat-format text and WAV audio; full-duplex sessions are not offered by this endpoint.",
          tags: ["LLM Proxy"],
          ...(withAgent ? { params: z.object({ agentId: UuidIdSchema }) } : {}),
          body: Azure.API.RealtimeTurnRequestSchema,
          headers: Azure.API.ChatCompletionsHeadersSchema,
          response: constructResponseSchema(
            Azure.API.ChatCompletionResponseSchema,
          ),
        },
      },
      async (request, reply) =>
        handleLLMProxy(
          request.body,
          request,
          reply,
          azureRealtimeAdapterFactory,
        ),
    );
  }

  for (const withAgent of [false, true]) {
    fastify.post(
      `${API_PREFIX}${withAgent ? "/:agentId" : ""}${IMAGES_SUFFIX}`,
      {
        bodyLimit: PROXY_BODY_LIMIT,
        schema: {
          operationId: withAgent
            ? RouteId.AzureImagesWithAgent
            : RouteId.AzureImagesWithDefaultAgent,
          description: "Generate images with Azure AI Foundry",
          tags: ["LLM Proxy"],
          ...(withAgent ? { params: z.object({ agentId: UuidIdSchema }) } : {}),
          body: Azure.API.ImageGenerationRequestSchema,
          headers: Azure.API.ChatCompletionsHeadersSchema,
          response: constructResponseSchema(
            Azure.API.ImageGenerationResponseSchema,
          ),
        },
      },
      async (request, reply) =>
        handleLLMProxy(request.body, request, reply, azureImagesAdapterFactory),
    );
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
      assertTextEndpoint(request.body.model, "/chat/completions");
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
      assertTextEndpoint(request.body.model, "/responses");
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
      assertTextEndpoint(request.body.model, "/responses");
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
      assertTextEndpoint(request.body.model, "/chat/completions");
      return handleLLMProxy(request.body, request, reply, azureAdapterFactory);
    },
  );
};

export default azureProxyRoutes;

function assertTextEndpoint(model: string, endpoint: string) {
  const kind = getAzureModelKind(model);
  const native =
    kind === "image"
      ? "/images/generations"
      : kind === "embedding"
        ? "/embeddings"
        : kind === "realtime" || kind === "translation"
          ? "/realtime/turns"
          : kind === "audio"
            ? "/chat/completions"
            : endpoint;
  if (native !== endpoint)
    throw new ApiError(
      400,
      `This deployment uses ${native}; send the request to that Azure proxy endpoint.`,
    );
}

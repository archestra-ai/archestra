import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { fetchAnthropicModels } from "@/routes/chat/model-fetchers/anthropic";
import { Anthropic, constructResponseSchema, UuidIdSchema } from "@/types";
import { anthropicAdapterFactory } from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import {
  AnthropicModelsHeadersSchema,
  AnthropicModelsListResponseSchema,
  extractAnthropicToken,
  resolveProxyModelsApiKey,
  toAnthropicModelsList,
} from "./proxy-model-listing";
import { createProxyPreHandler } from "./proxy-prehandler";

const anthropicProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const ANTHROPIC_PREFIX = `${PROXY_API_PREFIX}/anthropic`;
  const MESSAGES_SUFFIX = "/messages";

  logger.info("[UnifiedProxy] Registering unified Anthropic routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.anthropic.baseUrl,
    prefix: ANTHROPIC_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: ANTHROPIC_PREFIX,
      endpointSuffix: MESSAGES_SUFFIX,
      upstream: config.llm.anthropic.baseUrl,
      providerName: "Anthropic",
      rewritePrefix: "",
      skipErrorResponse: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "Messages requests should use the dedicated endpoint: POST /v1/anthropic/v1/messages",
        },
      },
    }),
  });

  /**
   * Anthropic SDK standard format (with /v1 prefix)
   * No agentId is provided -- agent is created/fetched based on the user-agent header
   */
  fastify.post(
    `${ANTHROPIC_PREFIX}/v1${MESSAGES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.AnthropicMessagesWithDefaultAgent,
        description: "Send a message to Anthropic using the default agent",
        tags: ["LLM Proxy"],
        body: Anthropic.API.MessagesRequestSchema,
        headers: Anthropic.API.MessagesHeadersSchema,
        response: constructResponseSchema(Anthropic.API.MessagesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.info(
        {
          url: request.url,
          headers: request.headers,
          bodyKeys: Object.keys(request.body || {}),
        },
        "[UnifiedProxy] Handling Anthropic request (default agent) - FULL REQUEST DEBUG",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        anthropicAdapterFactory,
      );
    },
  );

  /**
   * Anthropic SDK standard format (with /v1 prefix)
   * An agentId is provided -- agent is fetched based on the agentId
   *
   * NOTE: this is really only needed for n8n compatibility...
   */
  fastify.post(
    `${ANTHROPIC_PREFIX}/:agentId/v1${MESSAGES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.AnthropicMessagesWithAgent,
        description:
          "Send a message to Anthropic using a specific agent (n8n URL format)",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Anthropic.API.MessagesRequestSchema,
        headers: Anthropic.API.MessagesHeadersSchema,
        response: constructResponseSchema(Anthropic.API.MessagesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.info(
        {
          url: request.url,
          agentId: request.params.agentId,
          headers: request.headers,
          bodyKeys: Object.keys(request.body || {}),
        },
        "[UnifiedProxy] Handling Anthropic request (with agent) - FULL REQUEST DEBUG",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        anthropicAdapterFactory,
      );
    },
  );

  /**
   * Virtual-key-aware model listing. This dedicated handler shadows the blind
   * http-proxy passthrough — which forwards an `arch_*` virtual key verbatim to
   * api.anthropic.com and 401s — resolving the virtual key to its real upstream
   * key and returning Anthropic's native models shape.
   */
  async function handleListModels(
    request: FastifyRequest,
    agentId: string | undefined,
  ) {
    const { apiKey, baseUrl, extraHeaders } = await resolveProxyModelsApiKey({
      request,
      provider: "anthropic",
      token: extractAnthropicToken(request.headers),
    });
    logger.debug({ agentId }, "[UnifiedProxy] Listing Anthropic models");
    return toAnthropicModelsList(
      await fetchAnthropicModels(apiKey, baseUrl, extraHeaders),
    );
  }

  fastify.get(
    `${ANTHROPIC_PREFIX}/v1/models`,
    {
      schema: {
        operationId: RouteId.AnthropicListModelsWithDefaultAgent,
        description: "List Anthropic models (default agent)",
        tags: ["LLM Proxy"],
        headers: AnthropicModelsHeadersSchema,
        response: constructResponseSchema(AnthropicModelsListResponseSchema),
      },
    },
    async (request) => handleListModels(request, undefined),
  );

  fastify.get(
    `${ANTHROPIC_PREFIX}/:agentId/v1/models`,
    {
      schema: {
        operationId: RouteId.AnthropicListModelsWithAgent,
        description: "List Anthropic models (specific agent)",
        tags: ["LLM Proxy"],
        params: z.object({ agentId: UuidIdSchema }),
        headers: AnthropicModelsHeadersSchema,
        response: constructResponseSchema(AnthropicModelsListResponseSchema),
      },
    },
    async (request) => handleListModels(request, request.params.agentId),
  );
};

export default anthropicProxyRoutes;

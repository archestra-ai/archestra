import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { Anthropic, constructResponseSchema, UuidIdSchema } from "@/types";
import { anthropicAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const anthropicProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const ANTHROPIC_PREFIX = `${PROXY_API_PREFIX}/anthropic`;
  const MESSAGES_SUFFIX = "/messages";

  logger.info("[UnifiedProxy] Registering unified Anthropic routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.anthropic.baseUrl,
    prefix: ANTHROPIC_PREFIX,
    rewritePrefix: "/v1",
    preHandler: createProxyPreHandler({
      apiPrefix: ANTHROPIC_PREFIX,
      endpointSuffix: MESSAGES_SUFFIX,
      upstream: config.llm.anthropic.baseUrl,
      providerName: "Anthropic",
      rewritePrefix: "/v1",
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
        tags: ["llm-proxy"],
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
        tags: ["llm-proxy"],
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
};

export default anthropicProxyRoutesV2;

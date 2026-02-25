/**
 * Cohere v2 Chat API Routes
 *
 * Handles routing for Cohere LLM proxy endpoints.
 */

import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { Cohere, constructResponseSchema, UuidIdSchema } from "@/types";
import { cohereAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const cohereProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const COHERE_PREFIX = `${PROXY_API_PREFIX}/cohere`;
  // Public chat route should be provider-agnostic and not expose Cohere's internal path
  // e.g. POST /v1/cohere/:agentId/chat or POST /v1/cohere/chat
  const CHAT_SUFFIX = "/chat";

  logger.info("[UnifiedProxy] Registering unified Cohere routes");

  // Ensure proxy upstream is always a string to satisfy fastify-http-proxy types
  const cohereBaseUrl = config.llm.cohere.baseUrl ?? "https://api.cohere.ai";

  await fastify.register(fastifyHttpProxy, {
    upstream: cohereBaseUrl,
    prefix: COHERE_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: COHERE_PREFIX,
      endpointSuffix: CHAT_SUFFIX,
      upstream: cohereBaseUrl,
      providerName: "Cohere",
      skipErrorResponse: {
        error: {
          message: "Chat requests should use the dedicated endpoint",
          type: "invalid_request_error",
        },
      },
    }),
  });

  fastify.post(
    `${COHERE_PREFIX}${CHAT_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.CohereChatWithDefaultAgent,
        description: "Send a chat request to Cohere using the default agent",
        tags: ["llm-proxy"],
        body: Cohere.API.ChatRequestSchema,
        headers: Cohere.API.ChatHeadersSchema,
        response: constructResponseSchema(Cohere.API.ChatResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Cohere request (default agent)",
      );
      return handleLLMProxy(request.body, request, reply, cohereAdapterFactory);
    },
  );

  fastify.post(
    `${COHERE_PREFIX}/:agentId${CHAT_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.CohereChatWithAgent,
        description: "Send a chat request to Cohere using a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Cohere.API.ChatRequestSchema,
        headers: Cohere.API.ChatHeadersSchema,
        response: constructResponseSchema(Cohere.API.ChatResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Cohere request (with agent)",
      );
      return handleLLMProxy(request.body, request, reply, cohereAdapterFactory);
    },
  );
};

export default cohereProxyRoutesV2;

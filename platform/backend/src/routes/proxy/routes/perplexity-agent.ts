/**
 * Perplexity Agent LLM Proxy Routes — Responses-shaped
 *
 * Perplexity's Agent API at https://api.perplexity.ai/v1, reached over its
 * OpenAI-compatible `/responses` alias. This is the Perplexity surface that
 * accepts tools; the `sonar*` chat-completions models are proxied by
 * ./perplexity.ts instead and take none.
 *
 * @see https://docs.perplexity.ai/api-reference/agent-post
 */

import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import {
  constructResponseSchema,
  PerplexityAgent,
  UuidIdSchema,
} from "@/types";
import { perplexityAgentAdapterFactory } from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const perplexityAgentProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/perplexity-agent`;
  const RESPONSES_SUFFIX = "/responses";

  logger.info("[UnifiedProxy] Registering unified Perplexity Agent routes");

  // Registered before the handlers below and matching the whole prefix;
  // `endpointSuffix` is what makes it stand aside for them. Without it, a
  // `/responses` call is forwarded upstream verbatim — carrying the caller's
  // `arch_*` virtual key — and surfaces as a puzzling 401 from Perplexity.
  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm["perplexity-agent"].baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: RESPONSES_SUFFIX,
      upstream: config.llm["perplexity-agent"].baseUrl,
      providerName: "Perplexity Agent",
    }),
  });

  /**
   * Responses with default agent
   */
  fastify.post(
    `${API_PREFIX}${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.PerplexityAgentResponsesWithDefaultAgent,
        description:
          "Create a response with the Perplexity Agent API (uses default agent).",
        tags: ["LLM Proxy"],
        body: PerplexityAgent.API.ResponsesRequestSchema,
        headers: PerplexityAgent.API.ResponsesHeadersSchema,
        response: constructResponseSchema(
          PerplexityAgent.API.ResponsesResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Perplexity Agent request (default agent)",
      );
      return handleLLMProxy(
        request.body as PerplexityAgent.Types.ResponsesRequest,
        request,
        reply,
        perplexityAgentAdapterFactory,
      );
    },
  );

  /**
   * Responses with specific agent
   */
  fastify.post(
    `${API_PREFIX}/:agentId${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.PerplexityAgentResponsesWithAgent,
        description:
          "Create a response with the Perplexity Agent API for a specific agent.",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: PerplexityAgent.API.ResponsesRequestSchema,
        headers: PerplexityAgent.API.ResponsesHeadersSchema,
        response: constructResponseSchema(
          PerplexityAgent.API.ResponsesResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Perplexity Agent request (with agent)",
      );
      return handleLLMProxy(
        request.body as PerplexityAgent.Types.ResponsesRequest,
        request,
        reply,
        perplexityAgentAdapterFactory,
      );
    },
  );
};

export default perplexityAgentProxyRoutes;

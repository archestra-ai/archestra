/**
 * Perplexity LLM Proxy Routes - OpenAI-compatible
 *
 * Perplexity serves two surfaces off one key namespace, and this module
 * registers both:
 * - `/chat/completions` — the `sonar*` models. This endpoint takes NO external
 *   tool calling; it performs internal web searches and returns results in the
 *   search_results field.
 * - `/responses` — the Agent API (served upstream at `/v1`, reached over its
 *   OpenAI-compatible `/responses` alias). This is the Perplexity surface that
 *   accepts tools and serves the vendor-prefixed model catalog.
 *
 * @see https://docs.perplexity.ai/api-reference/chat-completions-post
 * @see https://docs.perplexity.ai/api-reference/agent-post
 */

import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, Perplexity, UuidIdSchema } from "@/types";
import {
  perplexityAdapterFactory,
  perplexityResponsesAdapterFactory,
} from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const perplexityProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/perplexity`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
  const RESPONSES_SUFFIX = "/responses";

  logger.info("[UnifiedProxy] Registering unified Perplexity routes");

  // Registered before the handlers below and matching the whole prefix;
  // `endpointSuffix` is what makes it stand aside for them. Without it, a
  // handled call is forwarded upstream verbatim — carrying the caller's
  // `arch_*` virtual key — and surfaces as a puzzling 401 from Perplexity.
  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.perplexity.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: [CHAT_COMPLETIONS_SUFFIX, RESPONSES_SUFFIX],
      upstream: config.llm.perplexity.baseUrl,
      providerName: "Perplexity",
    }),
  });

  /**
   * Chat completions with default agent
   */
  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.PerplexityChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with Perplexity (uses default agent). Note: this endpoint does not support external tool calling; the /responses Agent API endpoint does.",
        tags: ["LLM Proxy"],
        body: Perplexity.API.ChatCompletionRequestSchema,
        headers: Perplexity.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Perplexity.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Perplexity request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        perplexityAdapterFactory,
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
        operationId: RouteId.PerplexityChatCompletionsWithAgent,
        description:
          "Create a chat completion with Perplexity for a specific agent. Note: this endpoint does not support external tool calling; the /responses Agent API endpoint does.",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Perplexity.API.ChatCompletionRequestSchema,
        headers: Perplexity.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Perplexity.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Perplexity request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        perplexityAdapterFactory,
      );
    },
  );

  /**
   * Agent API responses with default agent
   */
  fastify.post(
    `${API_PREFIX}${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.PerplexityResponsesWithDefaultAgent,
        description:
          "Create a response with the Perplexity Agent API (uses default agent).",
        tags: ["LLM Proxy"],
        body: Perplexity.API.ResponsesRequestSchema,
        headers: Perplexity.API.ResponsesHeadersSchema,
        response: constructResponseSchema(
          Perplexity.API.ResponsesResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Perplexity Agent API request (default agent)",
      );
      return handleLLMProxy(
        request.body as Perplexity.Types.ResponsesRequest,
        request,
        reply,
        perplexityResponsesAdapterFactory,
      );
    },
  );

  /**
   * Agent API responses with specific agent
   */
  fastify.post(
    `${API_PREFIX}/:agentId${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.PerplexityResponsesWithAgent,
        description:
          "Create a response with the Perplexity Agent API for a specific agent.",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Perplexity.API.ResponsesRequestSchema,
        headers: Perplexity.API.ResponsesHeadersSchema,
        response: constructResponseSchema(
          Perplexity.API.ResponsesResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Perplexity Agent API request (with agent)",
      );
      return handleLLMProxy(
        request.body as Perplexity.Types.ResponsesRequest,
        request,
        reply,
        perplexityResponsesAdapterFactory,
      );
    },
  );
};

export default perplexityProxyRoutes;

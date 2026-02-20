/**
 * Perplexity LLM Proxy Routes - OpenAI-compatible
 *
 * Perplexity uses an OpenAI-compatible API at https://api.perplexity.ai
 * This module registers proxy routes for Perplexity chat completions.
 *
 * Note: Perplexity does NOT support external tool calling. It performs
 * internal web searches and returns results in the search_results field.
 *
 * @see https://docs.perplexity.ai/api-reference/chat-completions-post
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, Perplexity, UuidIdSchema } from "@/types";
import { perplexityAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const perplexityProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/perplexity`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified Perplexity routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.perplexity.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
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
          "Create a chat completion with Perplexity (uses default agent). Note: Perplexity does not support external tool calling.",
        tags: ["llm-proxy"],
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
          "Create a chat completion with Perplexity for a specific agent. Note: Perplexity does not support external tool calling.",
        tags: ["llm-proxy"],
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
};

export default perplexityProxyRoutesV2;

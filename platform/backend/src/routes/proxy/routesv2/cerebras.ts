/**
 * Cerebras LLM Proxy Routes - OpenAI-compatible
 *
 * Cerebras uses an OpenAI-compatible API at https://api.cerebras.ai/v1
 * This module registers proxy routes for Cerebras chat completions.
 *
 * @see https://inference-docs.cerebras.ai/
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { Cerebras, constructResponseSchema, UuidIdSchema } from "@/types";
import { cerebrasAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const cerebrasProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/cerebras`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified Cerebras routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.cerebras.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
      upstream: config.llm.cerebras.baseUrl,
      providerName: "Cerebras",
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
        operationId: RouteId.CerebrasChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with Cerebras (uses default agent)",
        tags: ["llm-proxy"],
        body: Cerebras.API.ChatCompletionRequestSchema,
        headers: Cerebras.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Cerebras.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Cerebras request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        cerebrasAdapterFactory,
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
        operationId: RouteId.CerebrasChatCompletionsWithAgent,
        description:
          "Create a chat completion with Cerebras for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Cerebras.API.ChatCompletionRequestSchema,
        headers: Cerebras.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Cerebras.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Cerebras request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        cerebrasAdapterFactory,
      );
    },
  );
};

export default cerebrasProxyRoutesV2;

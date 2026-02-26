/**
 * OpenRouter LLM Proxy Routes - OpenAI-compatible
 *
 * OpenRouter uses an OpenAI-compatible API at https://openrouter.ai/api/v1
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, Openrouter, UuidIdSchema } from "@/types";
import { openrouterAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const openrouterProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/openrouter`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified OpenRouter routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.openrouter.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
      upstream: config.llm.openrouter.baseUrl,
      providerName: "OpenRouter",
    }),
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenrouterChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with OpenRouter (uses default agent)",
        tags: ["llm-proxy"],
        body: Openrouter.API.ChatCompletionRequestSchema,
        headers: Openrouter.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Openrouter.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling OpenRouter request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        openrouterAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenrouterChatCompletionsWithAgent,
        description:
          "Create a chat completion with OpenRouter for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Openrouter.API.ChatCompletionRequestSchema,
        headers: Openrouter.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Openrouter.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling OpenRouter request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        openrouterAdapterFactory,
      );
    },
  );
};

export default openrouterProxyRoutesV2;

/**
 * Groq LLM Proxy Routes - OpenAI-compatible
 *
 * Groq uses an OpenAI-compatible API at https://api.groq.com/openai/v1
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, Groq, UuidIdSchema } from "@/types";
import { groqAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const groqProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/groq`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified Groq routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.groq.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
      upstream: config.llm.groq.baseUrl,
      providerName: "Groq",
    }),
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.GroqChatCompletionsWithDefaultAgent,
        description: "Create a chat completion with Groq (uses default agent)",
        tags: ["llm-proxy"],
        body: Groq.API.ChatCompletionRequestSchema,
        headers: Groq.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Groq.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Groq request (default agent)",
      );
      return handleLLMProxy(request.body, request, reply, groqAdapterFactory);
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.GroqChatCompletionsWithAgent,
        description: "Create a chat completion with Groq for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Groq.API.ChatCompletionRequestSchema,
        headers: Groq.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Groq.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Groq request (with agent)",
      );
      return handleLLMProxy(request.body, request, reply, groqAdapterFactory);
    },
  );
};

export default groqProxyRoutesV2;

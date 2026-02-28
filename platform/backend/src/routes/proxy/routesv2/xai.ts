/**
 * xAI LLM Proxy Routes - OpenAI-compatible
 *
 * xAI uses an OpenAI-compatible API at https://api.x.ai/v1
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, UuidIdSchema, Xai } from "@/types";
import { xaiAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const xaiProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/xai`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified xAI routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.xai.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
      upstream: config.llm.xai.baseUrl,
      providerName: "xAI",
    }),
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.XaiChatCompletionsWithDefaultAgent,
        description: "Create a chat completion with xAI (uses default agent)",
        tags: ["llm-proxy"],
        body: Xai.API.ChatCompletionRequestSchema,
        headers: Xai.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(Xai.API.ChatCompletionResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling xAI request (default agent)",
      );
      return handleLLMProxy(request.body, request, reply, xaiAdapterFactory);
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.XaiChatCompletionsWithAgent,
        description: "Create a chat completion with xAI for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Xai.API.ChatCompletionRequestSchema,
        headers: Xai.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(Xai.API.ChatCompletionResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling xAI request (with agent)",
      );
      return handleLLMProxy(request.body, request, reply, xaiAdapterFactory);
    },
  );
};

export default xaiProxyRoutesV2;

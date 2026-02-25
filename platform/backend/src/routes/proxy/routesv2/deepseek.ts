import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, DeepSeek, UuidIdSchema } from "@/types";
import { deepseekAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const deepseekProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/deepseek`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified DeepSeek routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.deepseek.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
      upstream: config.llm.deepseek.baseUrl,
      providerName: "DeepSeek",
    }),
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.DeepSeekChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with DeepSeek (uses default agent)",
        tags: ["llm-proxy"],
        body: DeepSeek.API.ChatCompletionRequestSchema,
        headers: DeepSeek.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          DeepSeek.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling DeepSeek request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        deepseekAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.DeepSeekChatCompletionsWithAgent,
        description:
          "Create a chat completion with DeepSeek for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: DeepSeek.API.ChatCompletionRequestSchema,
        headers: DeepSeek.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          DeepSeek.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling DeepSeek request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        deepseekAdapterFactory,
      );
    },
  );
};

export default deepseekProxyRoutesV2;

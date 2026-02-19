import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, UuidIdSchema, Zhipuai } from "@/types";
import { zhipuaiAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const zhipuaiProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/zhipuai`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified Zhipu AI routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.zhipuai.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
      upstream: config.llm.zhipuai.baseUrl,
      providerName: "Zhipu AI",
    }),
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.ZhipuaiChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with Zhipu AI (uses default agent)",
        tags: ["llm-proxy"],
        body: Zhipuai.API.ChatCompletionRequestSchema,
        headers: Zhipuai.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Zhipuai.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Zhipu AI request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        zhipuaiAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.ZhipuaiChatCompletionsWithAgent,
        description:
          "Create a chat completion with Zhipu AI for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Zhipuai.API.ChatCompletionRequestSchema,
        headers: Zhipuai.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Zhipuai.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Zhipu AI request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        zhipuaiAdapterFactory,
      );
    },
  );
};

export default zhipuaiProxyRoutesV2;

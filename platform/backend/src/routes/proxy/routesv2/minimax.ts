import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, Minimax, UuidIdSchema } from "@/types";
import { minimaxAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const minimaxProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/minimax`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified MiniMax routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.minimax.baseUrl as string,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
      upstream: config.llm.minimax.baseUrl as string,
      providerName: "MiniMax",
    }),
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.MinimaxChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with MiniMax (uses default agent)",
        tags: ["llm-proxy"],
        body: Minimax.API.ChatCompletionRequestSchema,
        headers: Minimax.API.ChatCompletionHeadersSchema,
        response: constructResponseSchema(
          Minimax.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling MiniMax request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        minimaxAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.MinimaxChatCompletionsWithAgent,
        description:
          "Create a chat completion with MiniMax for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Minimax.API.ChatCompletionRequestSchema,
        headers: Minimax.API.ChatCompletionHeadersSchema,
        response: constructResponseSchema(
          Minimax.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling MiniMax request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        minimaxAdapterFactory,
      );
    },
  );
};

export default minimaxProxyRoutesV2;

import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, Kimi, UuidIdSchema } from "@/types";
import { kimiAdapterFactory } from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const kimiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/kimi`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified Kimi routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.kimi.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
      upstream: config.llm.kimi.baseUrl,
      providerName: "Kimi",
    }),
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.KimiChatCompletionsWithDefaultAgent,
        description: "Create a chat completion with Kimi (uses default agent)",
        tags: ["LLM Proxy"],
        body: Kimi.API.ChatCompletionRequestSchema,
        headers: Kimi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Kimi.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Kimi request (default agent)",
      );
      return handleLLMProxy(request.body, request, reply, kimiAdapterFactory);
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.KimiChatCompletionsWithAgent,
        description: "Create a chat completion with Kimi for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Kimi.API.ChatCompletionRequestSchema,
        headers: Kimi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Kimi.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Kimi request (with agent)",
      );
      return handleLLMProxy(request.body, request, reply, kimiAdapterFactory);
    },
  );
};

export default kimiProxyRoutes;

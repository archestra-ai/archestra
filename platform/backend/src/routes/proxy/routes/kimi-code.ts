import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, KimiCode, UuidIdSchema } from "@/types";
import { kimiCodeAdapterFactory } from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { createPassthroughAuthenticator } from "../llm-proxy-auth";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const kimiCodeProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/kimi-code`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.debug("[UnifiedProxy] Registering unified Kimi Code routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm["kimi-code"].baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
      upstream: config.llm["kimi-code"].baseUrl,
      providerName: "Kimi Code",
      authenticate: createPassthroughAuthenticator("kimi-code"),
    }),
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.KimiCodeChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with Kimi Code (uses default agent)",
        tags: ["LLM Proxy"],
        body: KimiCode.API.ChatCompletionRequestSchema,
        headers: KimiCode.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          KimiCode.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Kimi Code request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        kimiCodeAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.KimiCodeChatCompletionsWithAgent,
        description:
          "Create a chat completion with Kimi Code for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: KimiCode.API.ChatCompletionRequestSchema,
        headers: KimiCode.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          KimiCode.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Kimi Code request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        kimiCodeAdapterFactory,
      );
    },
  );
};

export default kimiCodeProxyRoutes;

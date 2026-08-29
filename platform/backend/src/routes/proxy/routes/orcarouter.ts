/**
 * OrcaRouter LLM Proxy Routes - OpenAI-compatible
 *
 * OrcaRouter uses an OpenAI-compatible API at https://api.orcarouter.ai/v1
 */

import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, OrcaRouter, UuidIdSchema } from "@/types";
import { orcarouterAdapterFactory } from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const orcarouterProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/orcarouter`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified OrcaRouter routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.orcarouter.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
      upstream: config.llm.orcarouter.baseUrl,
      providerName: "OrcaRouter",
    }),
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OrcaRouterChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with OrcaRouter (uses default agent)",
        tags: ["LLM Proxy"],
        body: OrcaRouter.API.ChatCompletionRequestSchema,
        headers: OrcaRouter.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OrcaRouter.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling OrcaRouter request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        orcarouterAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OrcaRouterChatCompletionsWithAgent,
        description:
          "Create a chat completion with OrcaRouter for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OrcaRouter.API.ChatCompletionRequestSchema,
        headers: OrcaRouter.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OrcaRouter.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling OrcaRouter request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        orcarouterAdapterFactory,
      );
    },
  );
};

export default orcarouterProxyRoutes;

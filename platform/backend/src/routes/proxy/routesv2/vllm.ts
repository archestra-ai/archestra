/**
 * vLLM Proxy Routes
 *
 * vLLM exposes an OpenAI-compatible API, so these routes mirror the OpenAI routes.
 * See: https://docs.vllm.ai/en/latest/features/openai_api.html
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, UuidIdSchema, Vllm } from "@/types";
import { vllmAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const vllmProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/vllm`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified vLLM routes");

  // Only register HTTP proxy if vLLM is configured (has baseUrl)
  // Routes are always registered for OpenAPI schema generation
  if (config.llm.vllm.enabled) {
    await fastify.register(fastifyHttpProxy, {
      upstream: config.llm.vllm.baseUrl as string,
      prefix: API_PREFIX,
      rewritePrefix: "",
      preHandler: createProxyPreHandler({
        apiPrefix: API_PREFIX,
        endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
        upstream: config.llm.vllm.baseUrl as string,
        providerName: "vLLM",
      }),
    });
  } else {
    logger.info(
      "[UnifiedProxy] vLLM base URL not configured, HTTP proxy disabled",
    );
  }

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.VllmChatCompletionsWithDefaultAgent,
        description: "Create a chat completion with vLLM (uses default agent)",
        tags: ["llm-proxy"],
        body: Vllm.API.ChatCompletionRequestSchema,
        headers: Vllm.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Vllm.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      if (!config.llm.vllm.enabled) {
        return reply.status(500).send({
          error: {
            message:
              "vLLM provider is not configured. Set ARCHESTRA_VLLM_BASE_URL to enable.",
            type: "api_internal_server_error",
          },
        });
      }
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling vLLM request (default agent)",
      );
      return handleLLMProxy(request.body, request, reply, vllmAdapterFactory);
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.VllmChatCompletionsWithAgent,
        description: "Create a chat completion with vLLM for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Vllm.API.ChatCompletionRequestSchema,
        headers: Vllm.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Vllm.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      if (!config.llm.vllm.enabled) {
        return reply.status(500).send({
          error: {
            message:
              "vLLM provider is not configured. Set ARCHESTRA_VLLM_BASE_URL to enable.",
            type: "api_internal_server_error",
          },
        });
      }
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling vLLM request (with agent)",
      );
      return handleLLMProxy(request.body, request, reply, vllmAdapterFactory);
    },
  );
};

export default vllmProxyRoutesV2;

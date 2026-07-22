/**
 * Archestra Proxy Routes
 *
 * The "archestra" provider lets one Archestra instance route through another
 * Archestra's LLM proxy, which exposes an OpenAI-compatible chat-completions
 * API. The upstream endpoint has no global default — it is supplied per key as
 * a base URL (e.g. https://other-archestra/v1/proxy/openai/<agentId>) — so the
 * raw passthrough proxy is only registered when a global base URL is configured
 * (mirroring vLLM). The inference handlers always resolve the per-key base URL.
 */
import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { Archestra, constructResponseSchema, UuidIdSchema } from "@/types";
import { archestraAdapterFactory } from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

const archestraProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/archestra`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified Archestra routes");

  // Only register the raw passthrough proxy when a global base URL is
  // configured. Routes below are always registered for OpenAPI schema
  // generation and resolve the per-key base URL at request time.
  if (config.llm.archestra.enabled) {
    await fastify.register(fastifyHttpProxy, {
      upstream: config.llm.archestra.baseUrl as string,
      prefix: API_PREFIX,
      rewritePrefix: "",
      preHandler: createProxyPreHandler({
        apiPrefix: API_PREFIX,
        endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
        upstream: config.llm.archestra.baseUrl as string,
        providerName: "Archestra",
      }),
    });
  } else {
    logger.info(
      "[UnifiedProxy] Archestra base URL not configured, HTTP proxy disabled",
    );
  }

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.ArchestraChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with Archestra (uses default agent)",
        tags: ["LLM Proxy"],
        body: Archestra.API.ChatCompletionRequestSchema,
        headers: Archestra.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Archestra.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Archestra request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        archestraAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.ArchestraChatCompletionsWithAgent,
        description:
          "Create a chat completion with Archestra for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Archestra.API.ChatCompletionRequestSchema,
        headers: Archestra.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Archestra.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Archestra request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        archestraAdapterFactory,
      );
    },
  );
};

export default archestraProxyRoutes;

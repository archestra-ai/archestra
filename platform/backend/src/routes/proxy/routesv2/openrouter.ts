/**
 * OpenRouter LLM Proxy Routes - OpenAI-compatible
 *
 * OpenRouter uses an OpenAI-compatible API at https://api.openrouter.ai/v1
 * This module registers proxy routes for OpenRouter chat completions.
 *
 * @see https://inference-docs.openrouter.ai/
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { OpenRouter, constructResponseSchema, UuidIdSchema } from "@/types";
import { openrouterAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";

const openrouterProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/openrouter`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified OpenRouter routes");

  /**
   * Register HTTP proxy for OpenRouter routes
   * Chat completions are handled separately with full agent support
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.openrouter.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: (request, _reply, next) => {
      // Skip chat/completions - handled by custom handler below
      if (
        request.method === "POST" &&
        request.url.includes(CHAT_COMPLETIONS_SUFFIX)
      ) {
        logger.info(
          {
            method: request.method,
            url: request.url,
            action: "skip-proxy",
            reason: "handled-by-custom-handler",
          },
          "OpenRouter proxy preHandler: skipping chat/completions route",
        );
        next(new Error("skip"));
        return;
      }

      // Check if URL has UUID segment that needs stripping
      const pathAfterPrefix = request.url.replace(API_PREFIX, "");
      const uuidMatch = pathAfterPrefix.match(
        /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i,
      );

      if (uuidMatch) {
        // Strip UUID: /v1/openrouter/:uuid/path -> /v1/openrouter/path
        const remainingPath = uuidMatch[2] || "";
        const originalUrl = request.raw.url;
        request.raw.url = `${API_PREFIX}${remainingPath}`;

        logger.info(
          {
            method: request.method,
            originalUrl,
            rewrittenUrl: request.raw.url,
            upstream: config.llm.openrouter.baseUrl,
            finalProxyUrl: `${config.llm.openrouter.baseUrl}${remainingPath}`,
          },
          "OpenRouter proxy preHandler: URL rewritten (UUID stripped)",
        );
      } else {
        logger.info(
          {
            method: request.method,
            url: request.url,
            upstream: config.llm.openrouter.baseUrl,
            finalProxyUrl: `${config.llm.openrouter.baseUrl}${pathAfterPrefix}`,
          },
          "OpenRouter proxy preHandler: proxying request",
        );
      }

      next();
    },
  });

  /**
   * Chat completions with default agent
   */
  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenRouterChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with OpenRouter (uses default agent)",
        tags: ["llm-proxy"],
        body: OpenRouter.API.ChatCompletionRequestSchema,
        headers: OpenRouter.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenRouter.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling OpenRouter request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        openrouterAdapterFactory,
      );
    },
  );

  /**
   * Chat completions with specific agent
   */
  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenRouterChatCompletionsWithAgent,
        description:
          "Create a chat completion with OpenRouter for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenRouter.API.ChatCompletionRequestSchema,
        headers: OpenRouter.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenRouter.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling OpenRouter request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        openrouterAdapterFactory,
      );
    },
  );
};

export default openrouterProxyRoutesV2;

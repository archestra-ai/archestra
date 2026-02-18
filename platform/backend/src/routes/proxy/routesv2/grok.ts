/**
 * Grok LLM Proxy Routes - OpenAI-compatible
 *
 * Grok uses an OpenAI-compatible API at https://api.grok.ai/v1
 * This module registers proxy routes for Grok chat completions.
 *
 * @see https://inference-docs.grok.ai/
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { Grok, constructResponseSchema, UuidIdSchema } from "@/types";
import { grokAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";

const grokProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/grok`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified Grok routes");

  /**
   * Register HTTP proxy for Grok routes
   * Chat completions are handled separately with full agent support
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.grok.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: (request, reply, next) => {
      // Skip chat/completions - handled by custom handler below
      const urlPath = request.url.split("?")[0];
      if (
        request.method === "POST" &&
        urlPath.endsWith(CHAT_COMPLETIONS_SUFFIX)
      ) {
        logger.info(
          {
            method: request.method,
            url: request.url,
            action: "skip-proxy",
            reason: "handled-by-custom-handler",
          },
          "Grok proxy preHandler: skipping chat/completions route",
        );
        reply.code(400).send({
          error: {
            message:
              "Chat completions requests should use the dedicated endpoint",
            type: "invalid_request_error",
          },
        });
        return;
      }

      // Check if URL has UUID segment that needs stripping
      const pathAfterPrefix = request.url.replace(API_PREFIX, "");
      const uuidMatch = pathAfterPrefix.match(
        /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i,
      );

      if (uuidMatch) {
        // Strip UUID: /v1/grok/:uuid/path -> /v1/grok/path
        const remainingPath = uuidMatch[2] || "";
        const originalUrl = request.raw.url;
        request.raw.url = `${API_PREFIX}${remainingPath}`;

        logger.info(
          {
            method: request.method,
            originalUrl,
            rewrittenUrl: request.raw.url,
            upstream: config.llm.grok.baseUrl,
            finalProxyUrl: `${config.llm.grok.baseUrl}${remainingPath}`,
          },
          "Grok proxy preHandler: URL rewritten (UUID stripped)",
        );
      } else {
        logger.info(
          {
            method: request.method,
            url: request.url,
            upstream: config.llm.grok.baseUrl,
            finalProxyUrl: `${config.llm.grok.baseUrl}${pathAfterPrefix}`,
          },
          "Grok proxy preHandler: proxying request",
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
        operationId: RouteId.GrokChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with Grok (uses default agent)",
        tags: ["llm-proxy"],
        body: Grok.API.ChatCompletionRequestSchema,
        headers: Grok.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Grok.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Grok request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        grokAdapterFactory,
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
        operationId: RouteId.GrokChatCompletionsWithAgent,
        description:
          "Create a chat completion with Grok for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Grok.API.ChatCompletionRequestSchema,
        headers: Grok.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Grok.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Grok request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        grokAdapterFactory,
      );
    },
  );
};

export default grokProxyRoutesV2;

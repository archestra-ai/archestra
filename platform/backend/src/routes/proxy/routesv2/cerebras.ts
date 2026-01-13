/**
 * Cerebras LLM Proxy Routes - OpenAI-compatible
 *
 * Cerebras uses an OpenAI-compatible API at https://api.cerebras.ai/v1
 * This module registers proxy routes for Cerebras chat completions.
 *
 * @see https://inference-docs.cerebras.ai/
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { Cerebras, constructResponseSchema, UuidIdSchema } from "@/types";
import { cerebrasAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const cerebrasProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/cerebras`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified Cerebras routes");

  /**
   * Register HTTP proxy for Cerebras routes
   * Chat completions are handled separately with full agent support
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.cerebras.baseUrl,
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
          "Cerebras proxy preHandler: skipping chat/completions route",
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
        // Strip UUID: /v1/cerebras/:uuid/path -> /v1/cerebras/path
        const remainingPath = uuidMatch[2] || "";
        const originalUrl = request.raw.url;
        request.raw.url = `${API_PREFIX}${remainingPath}`;

        logger.info(
          {
            method: request.method,
            originalUrl,
            rewrittenUrl: request.raw.url,
            upstream: config.llm.cerebras.baseUrl,
            finalProxyUrl: `${config.llm.cerebras.baseUrl}${remainingPath}`,
          },
          "Cerebras proxy preHandler: URL rewritten (UUID stripped)",
        );
      } else {
        logger.info(
          {
            method: request.method,
            url: request.url,
            upstream: config.llm.cerebras.baseUrl,
            finalProxyUrl: `${config.llm.cerebras.baseUrl}${pathAfterPrefix}`,
          },
          "Cerebras proxy preHandler: proxying request",
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
        operationId: RouteId.CerebrasChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with Cerebras (uses default agent)",
        tags: ["llm-proxy"],
        body: Cerebras.API.ChatCompletionRequestSchema,
        headers: Cerebras.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Cerebras.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Cerebras request (default agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        cerebrasAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: undefined,
          externalAgentId,
          userId,
        },
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
        operationId: RouteId.CerebrasChatCompletionsWithAgent,
        description:
          "Create a chat completion with Cerebras for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Cerebras.API.ChatCompletionRequestSchema,
        headers: Cerebras.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Cerebras.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Cerebras request (with agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        cerebrasAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: request.params.agentId,
          externalAgentId,
          userId,
        },
      );
    },
  );
};

export default cerebrasProxyRoutesV2;

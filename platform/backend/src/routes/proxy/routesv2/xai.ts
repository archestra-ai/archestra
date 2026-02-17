/**
 * Xai LLM Proxy Routes - OpenAI-compatible
 *
 * Xai uses an OpenAI-compatible API at https://api.xai.ai/v1
 * This module registers proxy routes for Xai chat completions.
 *
 * @see https://docs.x.ai/api
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { Xai, constructResponseSchema, UuidIdSchema } from "@/types";
import { xaiAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const xaiProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/xai`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified Xai routes");

  /**
   * Register HTTP proxy for Xai routes
   * Chat completions are handled separately with full agent support
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.xai.baseUrl,
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
          "Xai proxy preHandler: skipping chat/completions route",
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
        // Strip UUID: /v1/xai/:uuid/path -> /v1/xai/path
        const remainingPath = uuidMatch[2] || "";
        const originalUrl = request.raw.url;
        request.raw.url = `${API_PREFIX}${remainingPath}`;

        logger.info(
          {
            method: request.method,
            originalUrl,
            rewrittenUrl: request.raw.url,
            upstream: config.llm.xai.baseUrl,
            finalProxyUrl: `${config.llm.xai.baseUrl}${remainingPath}`,
          },
          "Xai proxy preHandler: URL rewritten (UUID stripped)",
        );
      } else {
        logger.info(
          {
            method: request.method,
            url: request.url,
            upstream: config.llm.xai.baseUrl,
            finalProxyUrl: `${config.llm.xai.baseUrl}${pathAfterPrefix}`,
          },
          "Xai proxy preHandler: proxying request",
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
        operationId: RouteId.XaiChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with Xai (uses default agent)",
        tags: ["llm-proxy"],
        body: Xai.API.ChatCompletionRequestSchema,
        headers: Xai.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Xai.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Xai request (default agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        xaiAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: undefined,
          externalAgentId,
          executionId,
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
        operationId: RouteId.XaiChatCompletionsWithAgent,
        description:
          "Create a chat completion with Xai for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Xai.API.ChatCompletionRequestSchema,
        headers: Xai.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Xai.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Xai request (with agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        xaiAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: request.params.agentId,
          externalAgentId,
          executionId,
          userId,
        },
      );
    },
  );
};

export default xaiProxyRoutesV2;

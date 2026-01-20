import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { Cohere, constructResponseSchema, UuidIdSchema } from "@/types";
import { cohereAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const cohereProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/cohere`;
  const CHAT_SUFFIX = "/v2/chat";

  logger.info("[UnifiedProxy] Registering unified Cohere routes");

  /**
   * Register HTTP proxy for Cohere routes
   * Handles both patterns:
   * - /v1/cohere/:agentId/* -> https://api.cohere.ai/* (agentId stripped if UUID)
   * - /v1/cohere/* -> https://api.cohere.ai/* (direct proxy)
   *
   * Chat endpoint is excluded and handled separately below with full agent support
   */
  if (config.llm.cohere.enabled) {
    await fastify.register(fastifyHttpProxy, {
      upstream: config.llm.cohere.baseUrl as string,
      prefix: API_PREFIX,
      rewritePrefix: "",
      preHandler: (request, _reply, next) => {
        // Skip chat routes (we handle them specially below with full agent support)
        // Both /v2/chat and /chat/completions are handled by custom handlers
        if (
          request.method === "POST" &&
          (request.url.includes(CHAT_SUFFIX) ||
            request.url.includes("/chat/completions"))
        ) {
          logger.info(
            {
              method: request.method,
              url: request.url,
              action: "skip-proxy",
              reason: "handled-by-custom-handler",
            },
            "Cohere proxy preHandler: skipping chat route",
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
          // Strip UUID: /v1/cohere/:uuid/path -> /v1/cohere/path
          const remainingPath = uuidMatch[2] || "";
          const originalUrl = request.raw.url;
          request.raw.url = `${API_PREFIX}${remainingPath}`;

          logger.info(
            {
              method: request.method,
              originalUrl,
              rewrittenUrl: request.raw.url,
              upstream: config.llm.cohere.baseUrl,
              finalProxyUrl: `${config.llm.cohere.baseUrl}${remainingPath}`,
            },
            "Cohere proxy preHandler: URL rewritten (UUID stripped)",
          );
        } else {
          logger.info(
            {
              method: request.method,
              url: request.url,
              upstream: config.llm.cohere.baseUrl,
              finalProxyUrl: `${config.llm.cohere.baseUrl}${pathAfterPrefix}`,
            },
            "Cohere proxy preHandler: proxying request",
          );
        }

        next();
      },
    });
  }

  /**
   * Cohere v2 Chat API endpoint
   * No agentId is provided -- agent is created/fetched based on the user-agent header
   */
  fastify.post(
    `${API_PREFIX}${CHAT_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.CohereChatWithDefaultAgent,
        description: "Send a chat message to Cohere using the default agent",
        tags: ["llm-proxy"],
        body: Cohere.API.ChatRequestSchema,
        headers: Cohere.API.ChatHeadersSchema,
        response: constructResponseSchema(Cohere.API.ChatResponseSchema),
      },
    },
    async (request, reply) => {
      if (!config.llm.cohere.enabled) {
        return reply.status(500).send({
          error: {
            message:
              "Cohere is not configured. Set ARCHESTRA_COHERE_BASE_URL to enable.",
            type: "api_internal_server_error",
          },
        });
      }

      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Cohere request (default agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        cohereAdapterFactory,
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
   * Cohere chat/completions endpoint (OpenAI SDK compatibility)
   * Converts /chat/completions to /v2/chat for Cohere API
   * An agentId is provided -- agent is fetched based on the agentId
   */
  fastify.post(
    `${API_PREFIX}/:agentId/chat/completions`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.CohereChatWithAgent,
        description:
          "Send a chat message to Cohere for a specific agent (OpenAI SDK compatibility)",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: z.unknown(), // Accept OpenAI-compatible format, adapter will convert
        headers: z.record(z.string(), z.string()),
        response: constructResponseSchema(z.unknown()),
      },
    },
    async (request, reply) => {
      if (!config.llm.cohere.enabled) {
        return reply.status(500).send({
          error: {
            message:
              "Cohere is not configured. Set ARCHESTRA_COHERE_BASE_URL to enable.",
            type: "api_internal_server_error",
          },
        });
      }

      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Cohere request (with agent, OpenAI SDK format)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        cohereAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: request.params.agentId,
          externalAgentId,
          userId,
        },
      );
    },
  );

  /**
   * Cohere v2 Chat API endpoint
   * An agentId is provided -- agent is fetched based on the agentId
   */
  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.CohereChatWithAgent,
        description: "Send a chat message to Cohere for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Cohere.API.ChatRequestSchema,
        headers: Cohere.API.ChatHeadersSchema,
        response: constructResponseSchema(Cohere.API.ChatResponseSchema),
      },
    },
    async (request, reply) => {
      if (!config.llm.cohere.enabled) {
        return reply.status(500).send({
          error: {
            message:
              "Cohere is not configured. Set ARCHESTRA_COHERE_BASE_URL to enable.",
            type: "api_internal_server_error",
          },
        });
      }

      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Cohere request (with agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        cohereAdapterFactory,
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

export default cohereProxyRoutesV2;

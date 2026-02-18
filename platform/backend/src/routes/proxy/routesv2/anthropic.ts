import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { Anthropic, constructResponseSchema, UuidIdSchema } from "@/types";
import { anthropicAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";

const anthropicProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const ANTHROPIC_PREFIX = `${PROXY_API_PREFIX}/anthropic`;
  const MESSAGES_SUFFIX = "/messages";

  logger.info("[UnifiedProxy] Registering unified Anthropic routes");

  /**
   * Register HTTP proxy for Anthropic routes
   * Handles both patterns:
   * - /v1/anthropic/:agentId/* -> https://api.anthropic.com/v1/* (agentId stripped if UUID)
   * - /v1/anthropic/* -> https://api.anthropic.com/v1/* (direct proxy)
   *
   * Messages are excluded and handled separately below with full agent support
   */
  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.anthropic.baseUrl,
    prefix: ANTHROPIC_PREFIX,
    rewritePrefix: "/v1",
    preHandler: (request, reply, next) => {
      // Skip messages route (we handle it specially below with full agent support)
      // Use endsWith on the path portion (before query string) to avoid blocking
      // sub-paths like /messages/count_tokens or /messages/batches
      const urlPath = request.url.split("?")[0];
      if (request.method === "POST" && urlPath.endsWith(MESSAGES_SUFFIX)) {
        logger.info(
          {
            method: request.method,
            url: request.url,
            action: "skip-proxy",
            reason: "handled-by-custom-handler",
          },
          "Anthropic proxy preHandler: skipping messages route",
        );
        // Send a 400 response instead of throwing an Error to avoid flooding Sentry.
        // The dedicated messages routes (/v1/anthropic/v1/messages) handle these requests.
        reply.code(400).send({
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "Messages requests should use the dedicated endpoint: POST /v1/anthropic/v1/messages",
          },
        });
        return;
      }

      // Check if URL has UUID segment that needs stripping
      const pathAfterPrefix = request.url.replace(ANTHROPIC_PREFIX, "");
      const uuidMatch = pathAfterPrefix.match(
        /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i,
      );

      if (uuidMatch) {
        // Strip UUID: /v1/anthropic/:uuid/path -> /v1/anthropic/path
        const remainingPath = uuidMatch[2] || "";
        const originalUrl = request.raw.url;
        request.raw.url = `${ANTHROPIC_PREFIX}${remainingPath}`;

        logger.info(
          {
            method: request.method,
            originalUrl,
            rewrittenUrl: request.raw.url,
            upstream: config.llm.anthropic.baseUrl,
            finalProxyUrl: `${config.llm.anthropic.baseUrl}/v1${remainingPath}`,
          },
          "Anthropic proxy preHandler: URL rewritten (UUID stripped)",
        );
      } else {
        logger.info(
          {
            method: request.method,
            url: request.url,
            upstream: config.llm.anthropic.baseUrl,
            finalProxyUrl: `${config.llm.anthropic.baseUrl}/v1${pathAfterPrefix}`,
          },
          "Anthropic proxy preHandler: proxying request",
        );
      }

      next();
    },
  });

  /**
   * Anthropic SDK standard format (with /v1 prefix)
   * No agentId is provided -- agent is created/fetched based on the user-agent header
   */
  fastify.post(
    `${ANTHROPIC_PREFIX}/v1${MESSAGES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.AnthropicMessagesWithDefaultAgent,
        description: "Send a message to Anthropic using the default agent",
        tags: ["llm-proxy"],
        body: Anthropic.API.MessagesRequestSchema,
        headers: Anthropic.API.MessagesHeadersSchema,
        response: constructResponseSchema(Anthropic.API.MessagesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.info(
        {
          url: request.url,
          headers: request.headers,
          bodyKeys: Object.keys(request.body || {}),
        },
        "[UnifiedProxy] Handling Anthropic request (default agent) - FULL REQUEST DEBUG",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        anthropicAdapterFactory,
      );
    },
  );

  /**
   * Anthropic SDK standard format (with /v1 prefix)
   * An agentId is provided -- agent is fetched based on the agentId
   *
   * NOTE: this is really only needed for n8n compatibility...
   */
  fastify.post(
    `${ANTHROPIC_PREFIX}/:agentId/v1${MESSAGES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.AnthropicMessagesWithAgent,
        description:
          "Send a message to Anthropic using a specific agent (n8n URL format)",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Anthropic.API.MessagesRequestSchema,
        headers: Anthropic.API.MessagesHeadersSchema,
        response: constructResponseSchema(Anthropic.API.MessagesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.info(
        {
          url: request.url,
          agentId: request.params.agentId,
          headers: request.headers,
          bodyKeys: Object.keys(request.body || {}),
        },
        "[UnifiedProxy] Handling Anthropic request (with agent) - FULL REQUEST DEBUG",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        anthropicAdapterFactory,
      );
    },
  );
};

export default anthropicProxyRoutesV2;

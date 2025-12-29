/**
 * Anthropic Proxy Routes (V2 - Unified Handler)
 *
 * This module provides Anthropic LLM proxy routes using the unified handler architecture.
 * Routes are minimal - all business logic is in handleRequestWithErrors().
 */

import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { Anthropic, UuidIdSchema } from "@/types";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../../proxy/common";
import * as externalAgentId from "../../proxy/utils/external-agent-id";
import * as userId from "../../proxy/utils/user-id";
import { handleRequestWithErrors } from "../unified-handler";
import { anthropicProvider } from "./provider";

const anthropicProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/anthropic`;
  const MESSAGES_SUFFIX = "/messages";

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
    prefix: `${API_PREFIX}`,
    rewritePrefix: "/v1",
    preHandler: (request, _reply, next) => {
      // Skip messages route (we handle it specially below with full agent support)
      if (request.method === "POST" && request.url.includes(MESSAGES_SUFFIX)) {
        fastify.log.info(
          {
            method: request.method,
            url: request.url,
            action: "skip-proxy",
            reason: "handled-by-custom-handler",
          },
          "Anthropic proxy preHandler: skipping messages route",
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
        // Strip UUID: /v1/anthropic/:uuid/path -> /v1/anthropic/path
        const remainingPath = uuidMatch[2] || "";
        const originalUrl = request.raw.url;
        request.raw.url = `${API_PREFIX}${remainingPath}`;

        fastify.log.info(
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
        fastify.log.info(
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
   * Dual LLM callback factory for streaming progress updates
   */
  const createDualLlmCallbacks = (reply: {
    raw: { write: (data: string) => void };
  }) => ({
    onDualLlmStart: () => {
      const startEvent = {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "Analyzing with Dual LLM:\n\n",
        },
      };
      reply.raw.write(
        `event: content_block_delta\ndata: ${JSON.stringify(startEvent)}\n\n`,
      );
    },
    onDualLlmProgress: (progress: {
      question: string;
      options: string[];
      answer: string;
    }) => {
      const optionsText = progress.options
        .map((opt, idx) => `  ${idx}: ${opt}`)
        .join("\n");
      const progressEvent = {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: `Question: ${progress.question}\nOptions:\n${optionsText}\nAnswer: ${progress.answer}\n\n`,
        },
      };
      reply.raw.write(
        `event: content_block_delta\ndata: ${JSON.stringify(progressEvent)}\n\n`,
      );
    },
  });

  /**
   * Anthropic SDK standard format (with /v1 prefix)
   * No agentId is provided -- agent is created/fetched based on the user-agent header
   */
  fastify.post(
    `${API_PREFIX}/v1${MESSAGES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.AnthropicMessagesWithDefaultAgent,
        description: "Send a message to Anthropic using the default agent",
        tags: ["llm-proxy"],
        body: Anthropic.API.MessagesRequestSchema,
        headers: Anthropic.API.MessagesHeadersSchema,
      },
    },
    async (request, reply) => {
      const { body, headers } = request;
      const stream = !!body.stream;

      return handleRequestWithErrors({
        provider: anthropicProvider,
        request: body,
        reply,
        userAgent: headers["user-agent"],
        apiKey: headers["x-api-key"],
        externalAgentId: externalAgentId.getExternalAgentId(headers),
        userId: await userId.getUserId(headers),
        stream,
        dualLlmCallbacks: stream ? createDualLlmCallbacks(reply) : undefined,
        log: fastify.log,
      });
    },
  );

  /**
   * Anthropic SDK standard format (with /v1 prefix)
   * An agentId is provided -- agent is fetched based on the agentId
   *
   * NOTE: this is really only needed for n8n compatibility...
   */
  fastify.post(
    `${API_PREFIX}/:agentId/v1${MESSAGES_SUFFIX}`,
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
      },
    },
    async (request, reply) => {
      const { body, headers, params } = request;
      const stream = !!body.stream;

      return handleRequestWithErrors({
        provider: anthropicProvider,
        request: body,
        reply,
        agentId: params.agentId,
        userAgent: headers["user-agent"],
        apiKey: headers["x-api-key"],
        externalAgentId: externalAgentId.getExternalAgentId(headers),
        userId: await userId.getUserId(headers),
        stream,
        dualLlmCallbacks: stream ? createDualLlmCallbacks(reply) : undefined,
        log: fastify.log,
      });
    },
  );
};

export default anthropicProxyRoutesV2;

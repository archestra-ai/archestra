/**
 * x.AI Proxy Routes
 *
 * x.AI exposes an OpenAI-compatible API, so these routes mirror the OpenAI routes.
 * See: https://docs.xai.ai/en/latest/features/openai_api.html
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, UuidIdSchema, Xai } from "@/types";
import { xaiAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const xaiProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/xai`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified x.AI routes");

  // Only register HTTP proxy if x.AI is configured (has baseUrl)
  // Routes are always registered for OpenAPI schema generation
  if (config.llm.xai.enabled) {
    await fastify.register(fastifyHttpProxy, {
      upstream: config.llm.xai.baseUrl as string,
      prefix: API_PREFIX,
      rewritePrefix: "",
      preHandler: (request, _reply, next) => {
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
            "x.AI proxy preHandler: skipping chat/completions route",
          );
          next(new Error("skip"));
          return;
        }

        const pathAfterPrefix = request.url.replace(API_PREFIX, "");
        const uuidMatch = pathAfterPrefix.match(
          /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i,
        );

        if (uuidMatch) {
          const remainingPath = uuidMatch[2] || "";
          const originalUrl = request.raw.url;
          request.raw.url = `${API_PREFIX}${remainingPath}`;

          logger.info(
            {
              method: request.method,
              originalUrl,
              rewrittenUrl: request.raw.url,
              upstream: config.llm.xai.baseUrl,
              finalProxyUrl: `${config.llm.xai.baseUrl}/v1${remainingPath}`,
            },
            "x.AI proxy preHandler: URL rewritten (UUID stripped)",
          );
        } else {
          logger.info(
            {
              method: request.method,
              url: request.url,
              upstream: config.llm.xai.baseUrl,
              finalProxyUrl: `${config.llm.xai.baseUrl}/v1${pathAfterPrefix}`,
            },
            "x.AI proxy preHandler: proxying request",
          );
        }

        next();
      },
    });
  } else {
    logger.info(
      "[UnifiedProxy] x.AI base URL not configured, HTTP proxy disabled",
    );
  }

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.XaiChatCompletionsWithDefaultAgent,
        description: "Create a chat completion with x.AI (uses default agent)",
        tags: ["llm-proxy"],
        body: Xai.API.ChatCompletionRequestSchema,
        headers: Xai.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Xai.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      if (!config.llm.xai.enabled) {
        return reply.status(500).send({
          error: {
            message:
              "x.AI provider is not configured. Set ARCHESTRA_XAI_BASE_URL to enable.",
            type: "api_internal_server_error",
          },
        });
      }
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling x.AI request (default agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        xaiAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: undefined,
          externalAgentId,
          userId,
        },
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.XaiChatCompletionsWithAgent,
        description: "Create a chat completion with x.AI for a specific agent",
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
      if (!config.llm.xai.enabled) {
        return reply.status(500).send({
          error: {
            message:
              "x.AI provider is not configured. Set ARCHESTRA_XAI_BASE_URL to enable.",
            type: "api_internal_server_error",
          },
        });
      }
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling x.AI request (with agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        xaiAdapterFactory,
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

export default xaiProxyRoutesV2;

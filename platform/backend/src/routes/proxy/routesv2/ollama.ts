/**
 * Ollama Proxy Routes
 *
 * Ollama exposes an OpenAI-compatible API, so these routes mirror the OpenAI routes.
 * See: https://github.com/ollama/ollama/blob/main/docs/openai.md
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, Ollama, UuidIdSchema } from "@/types";
import { ollamaAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const ollamaProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/ollama`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified Ollama routes");

  // Only register HTTP proxy if Ollama is configured (has baseUrl)
  // Routes are always registered for OpenAPI schema generation
  if (config.llm.ollama.enabled) {
    await fastify.register(fastifyHttpProxy, {
      upstream: config.llm.ollama.baseUrl as string,
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
            "Ollama proxy preHandler: skipping chat/completions route",
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
              upstream: config.llm.ollama.baseUrl,
              finalProxyUrl: `${config.llm.ollama.baseUrl}/v1${remainingPath}`,
            },
            "Ollama proxy preHandler: URL rewritten (UUID stripped)",
          );
        } else {
          logger.info(
            {
              method: request.method,
              url: request.url,
              upstream: config.llm.ollama.baseUrl,
              finalProxyUrl: `${config.llm.ollama.baseUrl}/v1${pathAfterPrefix}`,
            },
            "Ollama proxy preHandler: proxying request",
          );
        }

        next();
      },
    });
  } else {
    logger.info(
      "[UnifiedProxy] Ollama base URL not configured, HTTP proxy disabled",
    );
  }

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OllamaChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with Ollama (uses default agent)",
        tags: ["llm-proxy"],
        body: Ollama.API.ChatCompletionRequestSchema,
        headers: Ollama.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Ollama.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      if (!config.llm.ollama.enabled) {
        return reply.status(500).send({
          error: {
            message:
              "Ollama provider is not configured. Set ARCHESTRA_OLLAMA_BASE_URL to enable.",
            type: "api_internal_server_error",
          },
        });
      }
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Ollama request (default agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        ollamaAdapterFactory,
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
        operationId: RouteId.OllamaChatCompletionsWithAgent,
        description:
          "Create a chat completion with Ollama for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Ollama.API.ChatCompletionRequestSchema,
        headers: Ollama.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Ollama.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      if (!config.llm.ollama.enabled) {
        return reply.status(500).send({
          error: {
            message:
              "Ollama provider is not configured. Set ARCHESTRA_OLLAMA_BASE_URL to enable.",
            type: "api_internal_server_error",
          },
        });
      }
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Ollama request (with agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userId = await utils.userId.getUserId(request.headers);
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        ollamaAdapterFactory,
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

export default ollamaProxyRoutesV2;

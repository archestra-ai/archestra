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

const UUID_PATTERN =
  /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i;

/**
 * Compute the rewritten `request.raw.url` for the Ollama HTTP proxy.
 *
 * Ollama serves its native API at root (`/api/*`) and its OpenAI-compatible
 * API under `/v1/` (`/v1/models`, `/v1/chat/completions`, …).
 *
 * The proxy is configured with `prefix: API_PREFIX` and `rewritePrefix: ""`,
 * so fastifyHttpProxy strips the API_PREFIX from `request.raw.url` and
 * forwards the remainder to the upstream Ollama server.
 *
 * This function:
 * 1. Strips any agent UUID from the path
 * 2. Prepends `/v1` for OpenAI-compat paths (anything not starting with `/api/`)
 * 3. Returns the new `request.raw.url` (which still includes the API_PREFIX so
 *    fastifyHttpProxy can strip it) and the `proxyPath` that will be forwarded.
 */
export function rewriteOllamaProxyUrl(
  requestUrl: string,
  apiPrefix: string,
): { rewrittenUrl: string; proxyPath: string; strippedUuid: boolean } {
  const pathAfterPrefix = requestUrl.replace(apiPrefix, "");
  const uuidMatch = pathAfterPrefix.match(UUID_PATTERN);

  const rawPath = uuidMatch ? uuidMatch[2] || "" : pathAfterPrefix;
  const proxyPath = rawPath.startsWith("/api/") ? rawPath : `/v1${rawPath}`;

  return {
    rewrittenUrl: `${apiPrefix}${proxyPath}`,
    proxyPath,
    strippedUuid: !!uuidMatch,
  };
}

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

        const { rewrittenUrl, proxyPath, strippedUuid } = rewriteOllamaProxyUrl(
          request.url,
          API_PREFIX,
        );
        request.raw.url = rewrittenUrl;

        logger.info(
          {
            method: request.method,
            originalUrl: request.url,
            rewrittenUrl,
            upstream: config.llm.ollama.baseUrl,
            finalProxyUrl: `${config.llm.ollama.baseUrl}${proxyPath}`,
          },
          strippedUuid
            ? "Ollama proxy preHandler: URL rewritten (UUID stripped)"
            : "Ollama proxy preHandler: proxying request",
        );

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
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        ollamaAdapterFactory,
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
      const executionId = utils.executionId.getExecutionId(request.headers);
      const userId = (await utils.user.getUser(request.headers))?.userId;
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        ollamaAdapterFactory,
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

export default ollamaProxyRoutesV2;

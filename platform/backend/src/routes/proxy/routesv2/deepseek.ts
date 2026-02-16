import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, UuidIdSchema, Deepseek } from "@/types";
import { deepseekAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const deepseekProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/deepseek`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified DeepSeek routes");

  if (config.llm.deepseek.enabled) {
    await fastify.register(fastifyHttpProxy, {
      upstream: config.llm.deepseek.baseUrl as string,
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
            "DeepSeek proxy preHandler: skipping chat/completions route",
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
              upstream: config.llm.deepseek.baseUrl,
              finalProxyUrl: `${config.llm.deepseek.baseUrl}${remainingPath}`,
            },
            "DeepSeek proxy preHandler: URL rewritten (UUID stripped)",
          );
        } else {
          logger.info(
            {
              method: request.method,
              url: request.url,
              upstream: config.llm.deepseek.baseUrl,
              finalProxyUrl: `${config.llm.deepseek.baseUrl}${pathAfterPrefix}`,
            },
            "DeepSeek proxy preHandler: proxying request",
          );
        }

        next();
      },
    });
  }

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.DeepSeekChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with DeepSeek (uses default agent)",
        tags: ["llm-proxy"],
        body: Deepseek.API.ChatCompletionRequestSchema,
        headers: Deepseek.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Deepseek.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      if (!config.llm.deepseek.enabled) {
        return reply.status(500).send({
          error: { 
            message: "DeepSeek is not configured. Set ARCHESTRA_DEEPSEEK_BASE_URL to enable.", 
            type: "api_internal_server_error" 
          }
        });
      }

      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling DeepSeek request (default agent)",
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
        deepseekAdapterFactory,
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
        operationId: RouteId.DeepSeekChatCompletionsWithAgent,
        description:
          "Create a chat completion with DeepSeek for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Deepseek.API.ChatCompletionRequestSchema,
        headers: Deepseek.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Deepseek.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      if (!config.llm.deepseek.enabled) {
        return reply.status(500).send({
          error: { 
            message: "DeepSeek is not configured. Set ARCHESTRA_DEEPSEEK_BASE_URL to enable.", 
            type: "api_internal_server_error" 
          }
        });
      }

      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling DeepSeek request (with agent)",
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
        deepseekAdapterFactory,
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

export default deepseekProxyRoutesV2;
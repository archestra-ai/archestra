/**
 * DeepSeek Proxy Routes
 */
import fastifyHttpProxy from "@fastify/http-proxy";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { constructResponseSchema, DeepSeek, UuidIdSchema } from "@/types";
import { deepseekAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const deepseekProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/deepseek`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified DeepSeek routes");

  // DeepSeek is always enabled as it uses the OpenAI SDK which is always present
  // But we only proxy if a baseUrl is configured (though DeepSeek has a default)
  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.deepseek.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: (request, _reply, next) => {
      if (
        request.method === "POST" &&
        request.url.includes(CHAT_COMPLETIONS_SUFFIX)
      ) {
        next(new Error("skip"));
        return;
      }

      const pathAfterPrefix = request.url.replace(API_PREFIX, "");
      const uuidMatch = pathAfterPrefix.match(
        /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i,
      );

      if (uuidMatch) {
        const remainingPath = uuidMatch[2] || "";
        request.raw.url = `${API_PREFIX}${remainingPath}`;
      }

      next();
    },
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.DeepseekChatCompletionsWithDefaultAgent,
        description: "Create a chat completion with DeepSeek (uses default agent)",
        tags: ["llm-proxy"],
        body: DeepSeek.API.ChatCompletionRequestSchema,
        headers: DeepSeek.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          DeepSeek.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
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
        operationId: RouteId.DeepseekChatCompletionsWithAgent,
        description: "Create a chat completion with DeepSeek for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: DeepSeek.API.ChatCompletionRequestSchema,
        headers: DeepSeek.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          DeepSeek.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
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
          userId,
        },
      );
    },
  );
};

export default deepseekProxyRoutesV2;

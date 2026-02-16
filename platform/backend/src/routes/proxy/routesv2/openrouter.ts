/**
 * OpenRouter LLM Proxy Routes (V2)
 *
 * OpenRouter provides an OpenAI-compatible API, so we use the same route structure
 * as OpenAI but with OpenRouter-specific adapter and configuration.
 *
 * @see https://openrouter.ai/docs/quickstart
 */
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { constructResponseSchema, OpenRouter, UuidIdSchema } from "@/types";
import { openrouterAdapterFactory } from "../adapterV2";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import * as utils from "../utils";

const openRouterProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/openrouter`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified OpenRouter routes");

  // OpenRouter uses OpenAI-compatible request/response schemas
  // Route without agent ID (uses default agent)
  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenRouterChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with OpenRouter (uses default agent)",
        tags: ["llm-proxy"],
        body: OpenRouter.API.ChatCompletionRequestSchema,
        headers: OpenRouter.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenRouter.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling OpenRouter request (default agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userResult = await utils.user.getUser(request.headers);
      const userId = userResult?.userId;
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        openrouterAdapterFactory,
        {
          organizationId: request.organizationId,
          agentId: undefined,
          externalAgentId,
          userId,
        },
      );
    },
  );

  // Route with agent ID
  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenRouterChatCompletionsWithAgent,
        description:
          "Create a chat completion with OpenRouter for a specific agent",
        tags: ["llm-proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenRouter.API.ChatCompletionRequestSchema,
        headers: OpenRouter.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenRouter.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling OpenRouter request (with agent)",
      );
      const externalAgentId = utils.externalAgentId.getExternalAgentId(
        request.headers,
      );
      const userResult = await utils.user.getUser(request.headers);
      const userId = userResult?.userId;
      return handleLLMProxy(
        request.body,
        request.headers,
        reply,
        openrouterAdapterFactory,
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

export default openRouterProxyRoutesV2;

import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { fetchMicrosoftCopilotModels } from "@/routes/chat/model-fetchers/microsoft-copilot";
import {
  constructResponseSchema,
  MicrosoftCopilot,
  UuidIdSchema,
} from "@/types";
import { microsoftCopilotAdapterFactory } from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import {
  extractBearerToken,
  OpenAiModelsHeadersSchema,
  OpenAiModelsListResponseSchema,
  resolveProxyModelsApiKey,
  toOpenAiModelsList,
} from "./proxy-model-listing";
import { createProxyPreHandler } from "./proxy-prehandler";

const microsoftCopilotProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/microsoft-copilot`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified Microsoft Copilot routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm["microsoft-copilot"].baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
      upstream: config.llm["microsoft-copilot"].baseUrl,
      providerName: "MicrosoftCopilot",
      // Graph only accepts the redeemed short-lived access token, and the
      // upstream is not OpenAI-compatible anyway — never forward the raw Entra
      // refresh token for an unsupported path; reject instead. With this flag
      // the preHandler replies 400 on every path and never calls next(), and
      // Fastify runs preHandler hooks strictly before the route handler where
      // http-proxy forwards — so no request can reach Graph through this
      // catch-all (pinned by proxy-prehandler.test.ts).
      rejectUnhandledPaths: true,
    }),
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.MicrosoftCopilotChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with Microsoft Copilot (uses default agent)",
        tags: ["LLM Proxy"],
        body: MicrosoftCopilot.API.ChatCompletionRequestSchema,
        headers: MicrosoftCopilot.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          MicrosoftCopilot.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Microsoft Copilot request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        microsoftCopilotAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.MicrosoftCopilotChatCompletionsWithAgent,
        description:
          "Create a chat completion with Microsoft Copilot for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: MicrosoftCopilot.API.ChatCompletionRequestSchema,
        headers: MicrosoftCopilot.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          MicrosoftCopilot.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Microsoft Copilot request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        microsoftCopilotAdapterFactory,
      );
    },
  );

  /**
   * Lists the static Microsoft Copilot pseudo-model for a virtual or raw key.
   * A dedicated route is needed for the same precedence reason as OpenAI's,
   * and doubly so here: the catch-all http-proxy would forward the raw Entra
   * refresh token upstream, but Graph only accepts the redeemed short-lived
   * access token. The fetcher performs that redemption (which also validates
   * the credential). Returns OpenAI's models shape.
   */
  async function handleListModels(
    request: FastifyRequest,
    agentId: string | undefined,
  ) {
    const { apiKey, baseUrl, extraHeaders } = await resolveProxyModelsApiKey({
      request,
      provider: "microsoft-copilot",
      token: extractBearerToken(request.headers.authorization),
    });
    logger.debug(
      { agentId },
      "[UnifiedProxy] Listing Microsoft Copilot models",
    );
    return toOpenAiModelsList(
      await fetchMicrosoftCopilotModels(apiKey, baseUrl, extraHeaders),
    );
  }

  fastify.get(
    `${API_PREFIX}/models`,
    {
      schema: {
        operationId: RouteId.MicrosoftCopilotListModelsWithDefaultAgent,
        description: "List Microsoft Copilot models (default agent)",
        tags: ["LLM Proxy"],
        headers: OpenAiModelsHeadersSchema,
        response: constructResponseSchema(OpenAiModelsListResponseSchema),
      },
    },
    async (request) => handleListModels(request, undefined),
  );

  fastify.get(
    `${API_PREFIX}/:agentId/models`,
    {
      schema: {
        operationId: RouteId.MicrosoftCopilotListModelsWithAgent,
        description: "List Microsoft Copilot models (specific agent)",
        tags: ["LLM Proxy"],
        params: z.object({ agentId: UuidIdSchema }),
        headers: OpenAiModelsHeadersSchema,
        response: constructResponseSchema(OpenAiModelsListResponseSchema),
      },
    },
    async (request) => handleListModels(request, request.params.agentId),
  );
};

export default microsoftCopilotProxyRoutes;

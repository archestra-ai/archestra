import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { fetchMicrosoft365CopilotModels } from "@/routes/chat/model-fetchers/microsoft-365-copilot";
import {
  constructResponseSchema,
  Microsoft365Copilot,
  UuidIdSchema,
} from "@/types";
import { microsoft365CopilotAdapterFactory } from "../adapters";
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

const microsoft365CopilotProxyRoutes: FastifyPluginAsyncZod = async (
  fastify,
) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/microsoft-365-copilot`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info(
    "[UnifiedProxy] Registering unified Microsoft 365 Copilot routes",
  );

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm["microsoft-365-copilot"].baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
      upstream: config.llm["microsoft-365-copilot"].baseUrl,
      providerName: "Microsoft365Copilot",
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
        operationId: RouteId.Microsoft365CopilotChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with Microsoft 365 Copilot (uses default agent)",
        tags: ["LLM Proxy"],
        body: Microsoft365Copilot.API.ChatCompletionRequestSchema,
        headers: Microsoft365Copilot.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Microsoft365Copilot.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Microsoft 365 Copilot request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        microsoft365CopilotAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.Microsoft365CopilotChatCompletionsWithAgent,
        description:
          "Create a chat completion with Microsoft 365 Copilot for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Microsoft365Copilot.API.ChatCompletionRequestSchema,
        headers: Microsoft365Copilot.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          Microsoft365Copilot.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Microsoft 365 Copilot request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        microsoft365CopilotAdapterFactory,
      );
    },
  );

  /**
   * Lists the static Microsoft 365 Copilot pseudo-model for a virtual or raw key.
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
      provider: "microsoft-365-copilot",
      token: extractBearerToken(request.headers.authorization),
    });
    logger.debug(
      { agentId },
      "[UnifiedProxy] Listing Microsoft 365 Copilot models",
    );
    return toOpenAiModelsList(
      await fetchMicrosoft365CopilotModels(apiKey, baseUrl, extraHeaders),
    );
  }

  fastify.get(
    `${API_PREFIX}/models`,
    {
      schema: {
        operationId: RouteId.Microsoft365CopilotListModelsWithDefaultAgent,
        description: "List Microsoft 365 Copilot models (default agent)",
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
        operationId: RouteId.Microsoft365CopilotListModelsWithAgent,
        description: "List Microsoft 365 Copilot models (specific agent)",
        tags: ["LLM Proxy"],
        params: z.object({ agentId: UuidIdSchema }),
        headers: OpenAiModelsHeadersSchema,
        response: constructResponseSchema(OpenAiModelsListResponseSchema),
      },
    },
    async (request) => handleListModels(request, request.params.agentId),
  );
};

export default microsoft365CopilotProxyRoutes;

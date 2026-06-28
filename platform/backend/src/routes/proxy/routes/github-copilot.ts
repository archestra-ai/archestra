import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { fetchGithubCopilotModels } from "@/routes/chat/model-fetchers/github-copilot";
import { constructResponseSchema, GithubCopilot, UuidIdSchema } from "@/types";
import { githubCopilotAdapterFactory } from "../adapters";
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

const githubCopilotProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/github-copilot`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified GitHub Copilot routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm["github-copilot"].baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: CHAT_COMPLETIONS_SUFFIX,
      upstream: config.llm["github-copilot"].baseUrl,
      providerName: "GitHubCopilot",
      // Copilot's API only accepts the exchanged short-lived bearer, so never
      // forward the raw GitHub token for an unsupported path — reject instead.
      rejectUnhandledPaths: true,
    }),
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.GithubCopilotChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with GitHub Copilot (uses default agent)",
        tags: ["LLM Proxy"],
        body: GithubCopilot.API.ChatCompletionRequestSchema,
        headers: GithubCopilot.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          GithubCopilot.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling GitHub Copilot request (default agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        githubCopilotAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.GithubCopilotChatCompletionsWithAgent,
        description:
          "Create a chat completion with GitHub Copilot for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: GithubCopilot.API.ChatCompletionRequestSchema,
        headers: GithubCopilot.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          GithubCopilot.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling GitHub Copilot request (with agent)",
      );
      return handleLLMProxy(
        request.body,
        request,
        reply,
        githubCopilotAdapterFactory,
      );
    },
  );

  /**
   * Lists Copilot models for a virtual or raw key. A dedicated route is
   * needed for the same precedence reason as OpenAI's, and doubly so here:
   * the catch-all http-proxy would forward the raw GitHub OAuth token
   * upstream, but Copilot endpoints only accept the short-lived exchanged
   * bearer. The fetcher performs that exchange. Returns OpenAI's models shape.
   */
  async function handleListModels(
    request: FastifyRequest,
    agentId: string | undefined,
  ) {
    const { apiKey, baseUrl, extraHeaders } = await resolveProxyModelsApiKey({
      request,
      provider: "github-copilot",
      token: extractBearerToken(request.headers.authorization),
    });
    logger.debug({ agentId }, "[UnifiedProxy] Listing GitHub Copilot models");
    return toOpenAiModelsList(
      await fetchGithubCopilotModels(apiKey, baseUrl, extraHeaders),
    );
  }

  fastify.get(
    `${API_PREFIX}/models`,
    {
      schema: {
        operationId: RouteId.GithubCopilotListModelsWithDefaultAgent,
        description: "List GitHub Copilot models (default agent)",
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
        operationId: RouteId.GithubCopilotListModelsWithAgent,
        description: "List GitHub Copilot models (specific agent)",
        tags: ["LLM Proxy"],
        params: z.object({ agentId: UuidIdSchema }),
        headers: OpenAiModelsHeadersSchema,
        response: constructResponseSchema(OpenAiModelsListResponseSchema),
      },
    },
    async (request) => handleListModels(request, request.params.agentId),
  );
};

export default githubCopilotProxyRoutes;

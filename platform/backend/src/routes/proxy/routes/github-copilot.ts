import AnthropicProvider from "@anthropic-ai/sdk";
import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { fetchGithubCopilotModels } from "@/routes/chat/model-fetchers/github-copilot";
import {
  Anthropic,
  constructResponseSchema,
  GithubCopilot,
  UuidIdSchema,
} from "@/types";
import { clientDisconnectSignal } from "@/utils/client-disconnect-signal";
import {
  githubCopilotAdapterFactory,
  githubCopilotResponsesAdapterFactory,
} from "../adapters";
import { githubCopilotMessagesAdapterFactory } from "../adapters/github-copilot-messages";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";
import {
  extractAnthropicToken,
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
  const RESPONSES_SUFFIX = "/responses";
  const MESSAGES_SUFFIX = "/v1/messages";

  logger.debug("[UnifiedProxy] Registering unified GitHub Copilot routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm["github-copilot"].baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: [
        CHAT_COMPLETIONS_SUFFIX,
        RESPONSES_SUFFIX,
        MESSAGES_SUFFIX,
        `${MESSAGES_SUFFIX}/count_tokens`,
      ],
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

  // Native Anthropic wire format: no model pool or Chat Completions translation.
  for (const withAgent of [false, true]) {
    fastify.post(
      `${API_PREFIX}${withAgent ? "/:agentId" : ""}${MESSAGES_SUFFIX}`,
      {
        bodyLimit: PROXY_BODY_LIMIT,
        schema: {
          operationId: withAgent
            ? RouteId.GithubCopilotMessagesWithAgent
            : RouteId.GithubCopilotMessagesWithDefaultAgent,
          description:
            "Create a native Anthropic Messages response with GitHub Copilot",
          tags: ["LLM Proxy"],
          ...(withAgent ? { params: z.object({ agentId: UuidIdSchema }) } : {}),
          body: Anthropic.API.MessagesRequestSchema,
          headers: Anthropic.API.MessagesHeadersSchema,
          response: constructResponseSchema(
            Anthropic.API.MessagesResponseWireSchema,
          ),
        },
      },
      async (request, reply) =>
        handleLLMProxy(
          request.body as Anthropic.Types.MessagesRequest,
          request,
          reply,
          githubCopilotMessagesAdapterFactory,
        ),
    );
  }

  // Counting is a non-generation operation: authorize it, but do not reserve
  // generation budgets or persist estimated tokens as billed model usage.
  for (const withAgent of [false, true]) {
    fastify.post(
      `${API_PREFIX}${withAgent ? "/:agentId" : ""}${MESSAGES_SUFFIX}/count_tokens`,
      {
        bodyLimit: PROXY_BODY_LIMIT,
        schema: {
          operationId: withAgent
            ? RouteId.GithubCopilotCountTokensWithAgent
            : RouteId.GithubCopilotCountTokensWithDefaultAgent,
          description:
            "Count native Anthropic Messages input tokens with GitHub Copilot",
          tags: ["LLM Proxy"],
          ...(withAgent ? { params: z.object({ agentId: UuidIdSchema }) } : {}),
          body: Anthropic.API.MessagesRequestSchema.omit({
            max_tokens: true,
            stream: true,
          }),
          headers: Anthropic.API.MessagesHeadersSchema,
          response: constructResponseSchema(
            z.object({ input_tokens: z.number().int().nonnegative() }),
          ),
        },
      },
      async (request, reply) => {
        const { apiKey, baseUrl, extraHeaders, providerApiKeyId } =
          await resolveProxyModelsApiKey({
            request,
            agentId: (request.params as { agentId?: string }).agentId,
            provider: "github-copilot",
            token: extractAnthropicToken(request.headers),
            requestedModel: request.body.model,
          });
        const client = githubCopilotMessagesAdapterFactory.createClient(
          apiKey,
          {
            source: "api",
            baseUrl,
            llmProviderApiKeyId: providerApiKeyId,
            abortSignal: clientDisconnectSignal({ request, reply }),
            defaultHeaders: {
              ...extraHeaders,
              ...(request.headers["anthropic-beta"]
                ? { "anthropic-beta": request.headers["anthropic-beta"] }
                : {}),
              ...(request.headers["anthropic-version"]
                ? { "anthropic-version": request.headers["anthropic-version"] }
                : {}),
            },
          },
        ) as AnthropicProvider;
        try {
          return await client.messages.countTokens(
            request.body as AnthropicProvider.Messages.MessageCountTokensParams,
          );
        } catch (error) {
          if (!(error instanceof AnthropicProvider.APIError)) throw error;
          // Preserve the upstream status and native error envelope, not SDK
          // diagnostics or request headers that could contain credentials.
          return (reply as FastifyReply)
            .code(error.status ?? 502)
            .type("application/json")
            .send(
              JSON.stringify(
                error.error ?? {
                  error: {
                    type: "api_error",
                    message: "GitHub Copilot token counting failed",
                  },
                },
              ),
            );
        }
      },
    );
  }

  /**
   * Copilot's Responses surface. Its Codex and GPT-5.x models declare
   * `supported_endpoints: ["/responses"]` and reject `/chat/completions`, so
   * this is the only route that can reach them.
   */
  fastify.post(
    `${API_PREFIX}${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.GithubCopilotResponsesWithDefaultAgent,
        description:
          "Create a response with GitHub Copilot (uses default agent)",
        tags: ["LLM Proxy"],
        body: GithubCopilot.API.ResponsesRequestSchema,
        headers: GithubCopilot.API.ResponsesHeadersSchema,
        response: constructResponseSchema(
          GithubCopilot.API.ResponsesResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling GitHub Copilot responses request (default agent)",
      );
      return handleLLMProxy(
        request.body as GithubCopilot.Types.ResponsesRequest,
        request,
        reply,
        githubCopilotResponsesAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.GithubCopilotResponsesWithAgent,
        description:
          "Create a response with GitHub Copilot for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: GithubCopilot.API.ResponsesRequestSchema,
        headers: GithubCopilot.API.ResponsesHeadersSchema,
        response: constructResponseSchema(
          GithubCopilot.API.ResponsesResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling GitHub Copilot responses request (with agent)",
      );
      return handleLLMProxy(
        request.body as GithubCopilot.Types.ResponsesRequest,
        request,
        reply,
        githubCopilotResponsesAdapterFactory,
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
    const { apiKey, baseUrl, extraHeaders, providerApiKeyId } =
      await resolveProxyModelsApiKey({
        request,
        agentId,
        provider: "github-copilot",
        token: extractBearerToken(request.headers.authorization),
      });
    logger.debug({ agentId }, "[UnifiedProxy] Listing GitHub Copilot models");
    return toOpenAiModelsList(
      // A stored plan key's App is read from the key itself.
      await fetchGithubCopilotModels(apiKey, baseUrl, extraHeaders, {
        providerApiKeyId,
      }),
      "github-copilot",
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

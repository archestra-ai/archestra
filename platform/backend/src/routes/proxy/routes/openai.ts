import { isCodexOriginator, RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isRateLimited } from "@/agents/utils";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { verifyOfferClaims } from "@/openappa/offer-claims";
import {
  SHELL_EXECUTION_PATH,
  shellExecutionCacheKey,
  signShellExecutionResponse,
  verifyShellExecutionTicket,
} from "@/openappa/shell-execution";
import { fetchOpenAiModels } from "@/routes/chat/model-fetchers/openai";
import {
  ApiError,
  constructResponseSchema,
  OpenAi,
  UuidIdSchema,
} from "@/types";
import {
  openAiEmbeddingsAdapterFactory,
  openAiResponsesAdapterFactory,
  openAiResponsesCompactAdapterFactory,
  openaiAdapterFactory,
} from "../adapters";
import {
  CHAT_COMPLETIONS_SUFFIX,
  EMBEDDINGS_SUFFIX,
  OPENAI_HANDLED_ENDPOINT_SUFFIXES,
  PROXY_API_PREFIX,
  PROXY_BODY_LIMIT,
  RESPONSES_COMPACT_SUFFIX,
  RESPONSES_SUFFIX,
} from "../common";
import {
  isJwtLike,
  resolveAgent,
  validatePassthroughVirtualKey,
  virtualKeyRateLimiter,
} from "../llm-proxy-auth";
import { handleLLMProxy } from "../llm-proxy-handler";
import {
  extractBearerToken,
  OpenAiModelsHeadersSchema,
  OpenAiModelsListResponseSchema,
  resolveProxyModelsApiKey,
  toOpenAiModelsList,
} from "./proxy-model-listing";
import { createProxyPreHandler } from "./proxy-prehandler";

const OpenAiModelsWithCodexSchema = OpenAiModelsListResponseSchema.extend({
  models: z
    .array(
      z.object({ slug: z.string(), display_name: z.string() }).passthrough(),
    )
    .optional(),
});

const CodexModelsSchema = z.object({
  models: z.array(
    z.object({ slug: z.string(), display_name: z.string() }).passthrough(),
  ),
});

const openAiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/openai`;

  logger.debug("[UnifiedProxy] Registering unified OpenAI routes");

  // Proxy routes bypass browser auth; this endpoint accepts only a leased,
  // single-use ticket signed for the exact APPA session and control call.
  fastify.post(
    SHELL_EXECUTION_PATH,
    {
      bodyLimit: 48 * 1024,
      schema: {
        hide: true,
        body: z.object({ ticket: z.string().min(1).max(32_768) }),
        response: constructResponseSchema(z.unknown()),
      },
    },
    async (request) => {
      if (!config.openappa.opencodeShellRemedy) {
        throw new ApiError(404, "OpenAPPA shell execution is disabled");
      }
      if (
        await isRateLimited(
          `${CacheKey.OpenAppaShellExecutionRateLimit}-${request.ip}`,
          { windowMs: 60_000, maxRequests: 60 },
        )
      ) {
        throw new ApiError(
          429,
          "Too many shell remedy requests. Try again later.",
        );
      }
      const ticket = verifyShellExecutionTicket({
        token: request.body.ticket,
        secret: config.openappa.offerSigningSecret,
      });
      const claims =
        ticket &&
        verifyOfferClaims(ticket.offer, config.openappa.offerSigningSecret);
      if (
        !ticket ||
        !claims ||
        claims.organization_id !== ticket.organizationId ||
        claims.session_id !== ticket.sessionId ||
        claims.caller_id !== ticket.callerId ||
        (claims.parent_id ?? undefined) !== ticket.parentId ||
        claims.offer_id !== ticket.arguments.offer_id
      ) {
        throw new ApiError(403, "Invalid OpenAPPA execution ticket");
      }
      const key = shellExecutionCacheKey(
        request.body.ticket,
      ) as AllowedCacheKey;
      const claimed = await cacheManager.getAndDeleteMany<{ nonce: string }>([
        key,
      ]);
      if (claimed[0]?.value.nonce !== ticket.nonce) {
        throw new ApiError(409, "OpenAPPA execution ticket was already used");
      }
      const result = await executeArchestraTool(
        "archestra__execute_remedy_plan",
        ticket.arguments,
        {
          agent: { id: ticket.agentId, name: "OpenAPPA proxy" },
          organizationId: ticket.organizationId,
          ...(ticket.callerId.startsWith("user:")
            ? { userId: ticket.callerId.slice("user:".length) }
            : {}),
          sessionId: ticket.sessionId,
          currentToolCallId: ticket.callId,
          mrtr: { enabled: true },
        },
      );
      return signShellExecutionResponse({
        ticket,
        result,
        secret: config.openappa.offerSigningSecret,
      });
    },
  );

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.openai.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: OPENAI_HANDLED_ENDPOINT_SUFFIXES,
      upstream: config.llm.openai.baseUrl,
      providerName: "OpenAI",
    }),
  });

  fastify.post(
    `${API_PREFIX}${EMBEDDINGS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiEmbeddingsWithDefaultAgent,
        description: "Create embeddings with OpenAI (uses default agent)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.EmbeddingRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.EmbeddingResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling OpenAI embeddings request (default agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.EmbeddingRequest,
        request,
        reply,
        openAiEmbeddingsAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${EMBEDDINGS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiEmbeddingsWithAgent,
        description: "Create embeddings with OpenAI for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.EmbeddingRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.EmbeddingResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling OpenAI embeddings request (with agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.EmbeddingRequest,
        request,
        reply,
        openAiEmbeddingsAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiResponsesWithDefaultAgent,
        description: "Create a response with OpenAI (uses default agent)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.ResponsesRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.ResponsesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling OpenAI responses request (default agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.ResponsesRequest,
        request,
        reply,
        openAiResponsesAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiResponsesWithAgent,
        description: "Create a response with OpenAI for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.ResponsesRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.ResponsesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling OpenAI responses request (with agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.ResponsesRequest,
        request,
        reply,
        openAiResponsesAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}${RESPONSES_COMPACT_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiResponsesCompactWithDefaultAgent,
        description: "Compact an OpenAI response (uses default agent)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.ResponsesCompactRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenAi.API.ResponsesCompactedResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling OpenAI responses compact request (default agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.ResponsesCompactRequest,
        request,
        reply,
        openAiResponsesCompactAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${RESPONSES_COMPACT_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiResponsesCompactWithAgent,
        description: "Compact an OpenAI response for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.ResponsesCompactRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenAi.API.ResponsesCompactedResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling OpenAI responses compact request (with agent)",
      );
      return handleLLMProxy(
        request.body as OpenAi.Types.ResponsesCompactRequest,
        request,
        reply,
        openAiResponsesCompactAdapterFactory,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion with OpenAI (uses default agent)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenAi.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling OpenAI request (default agent)",
      );
      return handleLLMProxy(request.body, request, reply, openaiAdapterFactory);
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiChatCompletionsWithAgent,
        description:
          "Create a chat completion with OpenAI for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenAi.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling OpenAI request (with agent)",
      );
      return handleLLMProxy(request.body, request, reply, openaiAdapterFactory);
    },
  );

  /**
   * Lists OpenAI models for a virtual or raw key. A dedicated route is needed
   * so it takes precedence over this prefix's catch-all http-proxy, which
   * would otherwise forward an `arch_*` key to api.openai.com unresolved and
   * 401. Returns OpenAI's native models shape.
   */
  async function handleListModels(
    request: FastifyRequest,
    agentId: string | undefined,
  ) {
    const headers = request.raw.headers;
    const bearer = extractBearerToken(headers.authorization);
    const originator =
      typeof headers.originator === "string" ? headers.originator : undefined;
    const isCodex = isCodexOriginator(originator);
    if (isCodex && originator && bearer && isJwtLike(bearer)) {
      if (typeof headers["chatgpt-account-id"] !== "string") {
        throw new ApiError(400, "Codex ChatGPT login requires an account ID.");
      }
      const passthroughToken = headers["x-archestra-virtual-key"];
      if (typeof passthroughToken !== "string") {
        throw new ApiError(
          401,
          "Codex ChatGPT login requires a passthrough virtual key.",
        );
      }
      await virtualKeyRateLimiter.check({
        ip: request.ip,
        credential: passthroughToken,
      });
      try {
        await validatePassthroughVirtualKey({
          tokenValue: passthroughToken,
          agent: await resolveAgent(agentId),
        });
        await virtualKeyRateLimiter.recordSuccess({
          credential: passthroughToken,
        });
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 401) {
          await virtualKeyRateLimiter.recordFailure({
            ip: request.ip,
            credential: passthroughToken,
          });
        }
        throw error;
      }
      const url = new URL(`${config.llm.openai.codex.apiBaseUrl}/models`);
      const clientVersion = new URL(
        request.url,
        "http://localhost",
      ).searchParams.get("client_version");
      if (clientVersion) {
        url.searchParams.set("client_version", clientVersion);
      }
      const upstream = await fetch(url, {
        headers: {
          authorization: `Bearer ${bearer}`,
          "chatgpt-account-id": headers["chatgpt-account-id"],
          originator,
        },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => {
        throw new ApiError(502, "Unable to fetch Codex subscription models.");
      });
      if (!upstream.ok) {
        throw new ApiError(
          upstream.status >= 500 ? 502 : upstream.status,
          "Unable to fetch Codex subscription models.",
        );
      }
      const result = CodexModelsSchema.safeParse(
        await upstream.json().catch(() => null),
      );
      if (!result.success) {
        throw new ApiError(502, "Invalid Codex subscription models response.");
      }
      const models = result.data.models.map((model) => ({
        id: model.slug,
        displayName: model.display_name,
        provider: "openai" as const,
      }));
      return {
        ...toOpenAiModelsList(models, "openai"),
        models: result.data.models,
      };
    }
    const { apiKey, baseUrl, extraHeaders } = await resolveProxyModelsApiKey({
      request,
      provider: "openai",
      token: extractBearerToken(request.headers.authorization),
    });
    logger.debug({ agentId }, "[UnifiedProxy] Listing OpenAI models");
    const models = await fetchOpenAiModels(apiKey, baseUrl, extraHeaders);
    const list = toOpenAiModelsList(models, "openai");
    return isCodex
      ? {
          ...list,
          models: models.map((model) => ({
            slug: model.id,
            display_name: model.displayName,
          })),
        }
      : list;
  }

  fastify.get(
    `${API_PREFIX}/models`,
    {
      schema: {
        operationId: RouteId.OpenAiListModelsWithDefaultAgent,
        description: "List OpenAI models (default agent)",
        tags: ["LLM Proxy"],
        headers: OpenAiModelsHeadersSchema,
        response: constructResponseSchema(OpenAiModelsWithCodexSchema),
      },
    },
    async (request) => handleListModels(request, undefined),
  );

  fastify.get(
    `${API_PREFIX}/:agentId/models`,
    {
      schema: {
        operationId: RouteId.OpenAiListModelsWithAgent,
        description: "List OpenAI models (specific agent)",
        tags: ["LLM Proxy"],
        params: z.object({ agentId: UuidIdSchema }),
        headers: OpenAiModelsHeadersSchema,
        response: constructResponseSchema(OpenAiModelsWithCodexSchema),
      },
    },
    async (request) => handleListModels(request, request.params.agentId),
  );
};

export default openAiProxyRoutes;

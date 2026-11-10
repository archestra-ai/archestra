/**
 * xAI LLM Proxy Routes - OpenAI-compatible
 *
 * xAI uses an OpenAI-compatible API at https://api.x.ai/v1.
 *
 * Native Grok subscription sessions use the vendor's Responses endpoint.
 * Other credentials keep the existing Responses-to-chat bridge.
 */

import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { collectDelegationMarkers } from "@/openappa/delegation";
import { fetchXaiModels } from "@/routes/chat/model-fetchers/xai";
import { setCollectedDelegationMarkers } from "@/routes/proxy/utils/delegation-markers";
import { setGrokNativePrivacy } from "@/services/grok-native-privacy";
import { ApiError, constructResponseSchema, UuidIdSchema, Xai } from "@/types";
import { xaiAdapterFactory, xaiOpenAiUsageAdapterFactory } from "../adapters";
import { makeResponsesFromChatAdapterFactory } from "../adapters/openai-responses-from-chat";
import { responsesToOpenaiChat } from "../adapters/openai-responses-translator";
import {
  fetchNativeGrokMetadata,
  nativeGrokSessionAdapter,
  resolveNativeGrokDefault,
} from "../adapters/xai-native-session";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { createPassthroughAuthenticator } from "../llm-proxy-auth";
import { handleLLMProxy } from "../llm-proxy-handler";
import {
  extractBearerToken,
  OpenAiModelsHeadersSchema,
  OpenAiModelsListResponseSchema,
  resolveProxyModelsApiKey,
  toOpenAiModelsList,
} from "./proxy-model-listing";
import { createProxyPreHandler } from "./proxy-prehandler";

async function handleXaiResponses(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const body = request.body as Xai.Types.ResponsesRequest;
  // The translation joins a message's text parts into one string, which can
  // leave a client's delegation marker mid-text (Kilo Code appends an
  // environment part after the prompt it was handed). Collect the markers
  // from the wire the client sent, where each still ends its own part.
  setCollectedDelegationMarkers(
    request,
    collectDelegationMarkers({ family: "openai:responses", body }),
  );
  const nativeAdapter = nativeGrokSessionAdapter(request.headers, "responses");
  if (nativeAdapter) {
    await authenticateNativeGrok(request);
    body.model = await resolveNativeGrokDefault({
      model: body.model,
      headers: request.headers,
      apiBackend: "responses",
    });
    return handleLLMProxy(body, request, reply, nativeAdapter);
  }
  const { chatBody, responsesContext } = responsesToOpenaiChat(body);
  return handleLLMProxy(
    chatBody,
    request,
    reply,
    // Responses' output_tokens counts reasoning, so the turn is read in
    // OpenAI's usage dialect, not xAI's.
    makeResponsesFromChatAdapterFactory(
      xaiOpenAiUsageAdapterFactory,
      responsesContext,
    ),
  );
}

const xaiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/xai`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
  const RESPONSES_SUFFIX = "/responses";

  logger.debug("[UnifiedProxy] Registering unified xAI routes");
  fastify.addHook("preHandler", async (request) => {
    if (
      request.headers["x-xai-token-auth"] === "xai-grok-cli" ||
      request.headers["x-archestra-grok-credential-mode"] === "native-session"
    ) {
      const pathname = request.url.split("?")[0];
      const metadata =
        request.method === "GET" &&
        pathname === request.url &&
        /^\/v1\/xai\/(?:[0-9a-f-]{36}\/)?native\/(?:models|settings|login-config)$/.test(
          pathname,
        );
      const privacy =
        request.method === "PUT" &&
        pathname === request.url &&
        /^\/v1\/xai\/(?:[0-9a-f-]{36}\/)?native\/privacy\/coding-data-retention$/.test(
          pathname,
        );
      if (
        !metadata &&
        !privacy &&
        (request.method !== "POST" ||
          (!pathname.endsWith(CHAT_COMPLETIONS_SUFFIX) &&
            !pathname.endsWith(RESPONSES_SUFFIX)))
      )
        throw new ApiError(
          400,
          "Native Grok credentials require a governed inference endpoint or an explicit native metadata endpoint.",
        );
    }
  });

  for (const withAgent of [false, true]) {
    fastify.get(
      `${API_PREFIX}${withAgent ? "/:agentId" : ""}/native/:kind`,
      {
        schema: {
          operationId: withAgent
            ? RouteId.XaiNativeMetadataWithAgent
            : RouteId.XaiNativeMetadataWithDefaultAgent,
          description:
            "Read authenticated native Grok subscription metadata. Does not admit an inference session.",
          tags: ["LLM Proxy"],
          params: z.object({
            ...(withAgent ? { agentId: UuidIdSchema } : {}),
            kind: z.enum(["models", "settings", "login-config"]),
          }),
          headers: Xai.API.ChatCompletionsHeadersSchema,
          response: constructResponseSchema(z.record(z.string(), z.unknown())),
        },
      },
      // codeql[js/missing-rate-limiting] The passthrough authenticator enforces distributed credential/IP failure limits before forwarding; rate-limit.native-grok.route.test.ts verifies the 401-to-429 boundary.
      async (request, reply) => {
        if (!nativeGrokSessionAdapter(request.headers))
          throw new ApiError(401, "Native Grok authentication is required.");
        await authenticateNativeGrok(request);
        reply.header("Cache-Control", "no-store");
        return fetchNativeGrokMetadata({
          name: request.params.kind,
          headers: request.headers,
          signal: AbortSignal.timeout(10000),
        });
      },
    );
    fastify.put(
      `${API_PREFIX}${withAgent ? "/:agentId" : ""}/native/privacy/coding-data-retention`,
      {
        bodyLimit: 4096,
        schema: {
          operationId: withAgent
            ? RouteId.XaiNativePrivacyWithAgent
            : RouteId.XaiNativePrivacyWithDefaultAgent,
          description:
            "Update the caller's native Grok coding-data-sharing preference.",
          tags: ["LLM Proxy"],
          params: z.object(withAgent ? { agentId: UuidIdSchema } : {}),
          headers: Xai.API.ChatCompletionsHeadersSchema,
          body: z.object({ codingDataRetentionOptOut: z.boolean() }).strict(),
          response: constructResponseSchema(
            z.object({ codingDataRetentionOptOut: z.boolean() }),
          ),
        },
      },
      // codeql[js/missing-rate-limiting] The passthrough authenticator enforces distributed credential/IP failure limits before forwarding; rate-limit.native-grok.route.test.ts verifies the 401-to-429 boundary.
      async (request, reply) => {
        if (!nativeGrokSessionAdapter(request.headers))
          throw new ApiError(401, "Native Grok authentication is required.");
        const identity = await createPassthroughAuthenticator("xai")({
          request,
          agentId: (request.params as { agentId?: string }).agentId,
        });
        reply.header("Cache-Control", "no-store");
        return setGrokNativePrivacy({
          request,
          identity,
          optOut: request.body.codingDataRetentionOptOut,
        });
      },
    );
  }

  async function handleListModels(
    request: FastifyRequest,
    agentId: string | undefined,
  ) {
    const { apiKey, baseUrl, extraHeaders } = await resolveProxyModelsApiKey({
      request,
      agentId,
      provider: "xai",
      token: extractBearerToken(request.headers.authorization),
    });
    return toOpenAiModelsList(
      await fetchXaiModels(apiKey, baseUrl, extraHeaders, {
        boundedDiscovery: true,
      }),
      "xai",
    );
  }

  fastify.get(
    `${API_PREFIX}/models`,
    {
      schema: {
        operationId: RouteId.XaiListModelsWithDefaultAgent,
        description: "List available xAI models (default agent)",
        tags: ["LLM Proxy"],
        headers: OpenAiModelsHeadersSchema,
        response: constructResponseSchema(OpenAiModelsListResponseSchema),
      },
    },
    (request) => handleListModels(request, undefined),
  );
  fastify.get(
    `${API_PREFIX}/:agentId/models`,
    {
      schema: {
        operationId: RouteId.XaiListModelsWithAgent,
        description: "List available xAI models (specific agent)",
        tags: ["LLM Proxy"],
        params: z.object({ agentId: UuidIdSchema }),
        headers: OpenAiModelsHeadersSchema,
        response: constructResponseSchema(OpenAiModelsListResponseSchema),
      },
    },
    (request) => handleListModels(request, request.params.agentId),
  );

  const catchallPreHandler = createProxyPreHandler({
    apiPrefix: API_PREFIX,
    endpointSuffix: [CHAT_COMPLETIONS_SUFFIX, RESPONSES_SUFFIX],
    upstream: config.llm.xai.baseUrl,
    providerName: "xAI",
    authenticate: createPassthroughAuthenticator("xai"),
    skipErrorResponse: {
      error: {
        message:
          "Chat completions and Responses requests should use the dedicated endpoints",
        type: "invalid_request_error",
      },
    },
  });
  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.xai.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: (request, reply, next) => {
      if (
        request.headers["x-xai-token-auth"] === "xai-grok-cli" ||
        request.headers["x-archestra-grok-credential-mode"] === "native-session"
      ) {
        next(
          new ApiError(
            400,
            "Native Grok credentials cannot use passthrough endpoints. Use a governed inference endpoint.",
          ),
        );
        return;
      }
      for (const headers of new Set([request.headers, request.raw.headers])) {
        for (const name of Object.keys(headers)) {
          if (
            name === "cookie" ||
            name === "x-xai-token-auth" ||
            name === "x-authenticateresponse" ||
            name === "x-userid" ||
            name === "x-email" ||
            name.startsWith("x-grok-")
          )
            delete headers[name];
        }
      }
      catchallPreHandler(request, reply, next);
    },
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.XaiChatCompletionsWithDefaultAgent,
        description: "Create a chat completion with xAI (uses default agent)",
        tags: ["LLM Proxy"],
        body: Xai.API.ChatCompletionRequestSchema,
        headers: Xai.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(Xai.API.ChatCompletionResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling xAI request (default agent)",
      );
      const adapter =
        nativeGrokSessionAdapter(request.headers) ?? xaiAdapterFactory;
      if (adapter !== xaiAdapterFactory) {
        await authenticateNativeGrok(request);
        request.body.model = await resolveNativeGrokDefault({
          model: request.body.model,
          headers: request.headers,
        });
      }
      return handleLLMProxy(request.body, request, reply, adapter);
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.XaiChatCompletionsWithAgent,
        description: "Create a chat completion with xAI for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Xai.API.ChatCompletionRequestSchema,
        headers: Xai.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(Xai.API.ChatCompletionResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling xAI request (with agent)",
      );
      const adapter =
        nativeGrokSessionAdapter(request.headers) ?? xaiAdapterFactory;
      if (adapter !== xaiAdapterFactory) {
        await authenticateNativeGrok(request);
        request.body.model = await resolveNativeGrokDefault({
          model: request.body.model,
          headers: request.headers,
        });
      }
      return handleLLMProxy(request.body, request, reply, adapter);
    },
  );

  fastify.post(
    `${API_PREFIX}${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.XaiResponsesWithDefaultAgent,
        description:
          "Create a response with xAI (uses default agent). Served over xAI's chat completions.",
        tags: ["LLM Proxy"],
        body: Xai.API.ResponsesRequestSchema,
        headers: Xai.API.ResponsesHeadersSchema,
        response: constructResponseSchema(Xai.API.ResponsesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling xAI Responses request (default agent)",
      );
      return handleXaiResponses(request, reply);
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.XaiResponsesWithAgent,
        description:
          "Create a response with xAI for a specific agent. Served over xAI's chat completions.",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Xai.API.ResponsesRequestSchema,
        headers: Xai.API.ResponsesHeadersSchema,
        response: constructResponseSchema(Xai.API.ResponsesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling xAI Responses request (with agent)",
      );
      return handleXaiResponses(request, reply);
    },
  );
};

export default xaiProxyRoutes;

async function authenticateNativeGrok(request: FastifyRequest) {
  await createPassthroughAuthenticator("xai")({
    request,
    agentId: (request.params as { agentId?: string }).agentId,
  });
}

import {
  hasArchestraTokenPrefix,
  isChatCompletionsOnlyRouterProvider,
  LLM_PROXY_OAUTH_SCOPE,
  lacksOpenAiChatCompletions,
  MODEL_ROUTER_SUPPORTED_PROVIDERS,
  providerDisplayNames,
  RouteId,
  requiresResponsesApi,
  type SupportedProvider,
} from "@archestra/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import {
  AUTO_MODEL,
  autoModelAvailable,
  resolveAutoModel,
} from "@/auto-routing/router";
import { isAzureOpenAiFirstPartyModelName } from "@/clients/azure-url";
import config, { getProviderConfiguredBaseUrl } from "@/config";
import logger from "@/logging";
import {
  ManagedOauthClientModel as LlmOauthClientModel,
  LlmProviderApiKeyModel,
  MemberModel,
  ModelPoolModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  VirtualApiKeyModel,
} from "@/models";
import AgentTeamModel from "@/models/agent-team";
import { getLlmProxyRequestTelemetry } from "@/observability/llm-proxy-request";
import { collectDelegationMarkers } from "@/openappa/delegation";
import { scrubTranslatedClientWire } from "@/proxy/plugins/appa-plugin-archestra/host/ingress";
import { setCollectedDelegationMarkers } from "@/routes/proxy/utils/delegation-markers";
import { isAppConnectorAudienceRef } from "@/services/apps/app-connector-resource";
import { resolveAzureModelCapabilities } from "@/services/azure-model-capabilities";
import { resolveOauthClientProviderMappings } from "@/services/oauth-client-providers";
import { resolveOauthServiceAccount } from "@/services/oauth-service-account";
import { ResourcePermissions } from "@/services/resource-permissions";
import { resolveVirtualKeyProviderMappings } from "@/services/virtual-key-providers";
import type { GatewayAgent, LLMProvider } from "@/types";
import {
  ApiError,
  Azure,
  constructResponseSchema,
  GithubCopilot,
  OpenAi,
  UuidIdSchema,
} from "@/types";
import { CacheControlSchema } from "@/types/llm-providers/openai/messages";
import {
  azureAdapterFactory,
  azureResponsesAdapterFactory,
  cerebrasAdapterFactory,
  deepseekAdapterFactory,
  geminiEmbeddingsAdapterFactory,
  githubCopilotAdapterFactory,
  githubCopilotResponsesAdapterFactory,
  groqAdapterFactory,
  kimiAdapterFactory,
  kimiCodeAdapterFactory,
  makeOpenAiCompatibleEmbeddingsAdapterFactory,
  minimaxAdapterFactory,
  mistralAdapterFactory,
  ollamaAdapterFactory,
  openAiEmbeddingsAdapterFactory,
  openAiResponsesAdapterFactory,
  openaiAdapterFactory,
  openrouterAdapterFactory,
  perplexityAdapterFactory,
  vllmAdapterFactory,
  xaiAdapterFactory,
  zhipuaiAdapterFactory,
} from "../adapters";
import { makeAnthropicOpenaiAdapterFactory } from "../adapters/anthropic-openai";
import { openaiToAnthropic } from "../adapters/anthropic-openai-translator";
import { azureEmbeddingsAdapterFactory } from "../adapters/azure";
import { azureImagesAdapterFactory } from "../adapters/azure-images";
import { makeBedrockOpenaiAdapterFactory } from "../adapters/bedrock-openai";
import { openaiToConverse } from "../adapters/bedrock-openai-translator";
import { makeCohereOpenaiAdapterFactory } from "../adapters/cohere-openai";
import { openaiToCohere } from "../adapters/cohere-openai-translator";
import {
  EmbeddingWireResponseSchema,
  withEmbeddingEncoding,
} from "../adapters/embeddings-wire";
import {
  geminiImagesAdapterFactory,
  toGeminiImageRequest,
} from "../adapters/gemini-images";
import { makeGeminiOpenaiAdapterFactory } from "../adapters/gemini-openai";
import {
  decodeSignedToolCallId,
  openaiToGemini,
} from "../adapters/gemini-openai-translator";
import { openaiImagesAdapterFactory } from "../adapters/openai-images";
import { makeResponsesFromChatAdapterFactory } from "../adapters/openai-responses-from-chat";
import {
  type OpenaiResponsesContext,
  responsesToOpenaiChat,
} from "../adapters/openai-responses-translator";
import { MODEL_ROUTER_PREFIX, PROXY_BODY_LIMIT } from "../common";
import {
  handleImageEdit,
  ImageEditMultipartBodySchema,
  parseImageEditRequest,
} from "../image-edit-handler";
import {
  resolveAgent,
  validateVirtualApiKeyToken,
  virtualKeyRateLimiter,
} from "../llm-proxy-auth";
import {
  handleLLMProxy,
  type LLMProxyAuthOverride,
  sendUsageLimitRefusal,
} from "../llm-proxy-handler";
import { classifyProxyFailure } from "../llm-proxy-helpers";
import { type ModelPoolCaller, mayUseModelPool } from "../model-pool-failover";
import {
  type ModelRouterAuth,
  type ModelRouterMappedProviderKey,
  type ModelRouterOAuthClientAuth,
  type ModelRouterUserOAuthAuth,
  modelRouterAuthenticatedUserId,
  nativeResponsesProvider,
  selectModelRouterCredential,
  userProviderKeyMappings,
} from "../model-router-access";
import { assertModelRouterCacheControls } from "../model-router-cache-controls";
import {
  buildRoutableModelId,
  listRoutableModels,
  type ModelRouterResolution,
  resolveModelRoute,
} from "../model-router-resolver";
import { rejectUnsupportedProxyFileReferences } from "../provider-file-handler";
import { registerMediaMultipartParser } from "../utils/media-multipart";
import {
  AudioMultipartBodySchema,
  type AudioProxyBody,
  AudioSpeechRequestSchema,
  handleAudioProxy,
  parseAudioUploadRequest,
} from "./audio";

const mediaAuth = new WeakMap<FastifyRequest, ModelRouterAuth>();

const RouterChatRequestSchema = OpenAi.API.ChatCompletionRequestSchema.extend({
  cache_control: CacheControlSchema.optional(),
  cachedContent: z.string().optional(),
});

type OpenAiWireProvider = LLMProvider<
  OpenAi.Types.ChatCompletionsRequest,
  unknown,
  unknown,
  unknown,
  OpenAi.Types.ChatCompletionsHeaders
>;

type EmbeddingsModelRouterProvider = LLMProvider<
  OpenAi.Types.EmbeddingRequest,
  OpenAi.Types.EmbeddingResponse,
  OpenAi.Types.ChatCompletionsRequest["messages"],
  never,
  OpenAi.Types.ChatCompletionsHeaders
>;

type OpenAiWireModelRouterProvider = {
  kind: "openai-wire";
  body: OpenAi.Types.ChatCompletionsRequest;
  adapter: OpenAiWireProvider;
};

type AnthropicModelRouterProvider = {
  kind: "anthropic";
  body: ReturnType<typeof openaiToAnthropic>["anthropicBody"];
  adapter: ReturnType<typeof makeAnthropicOpenaiAdapterFactory>;
};

type BedrockModelRouterProvider = {
  kind: "bedrock";
  body: ReturnType<typeof openaiToConverse>["converseBody"];
  adapter: ReturnType<typeof makeBedrockOpenaiAdapterFactory>;
};

type CohereModelRouterProvider = {
  kind: "cohere";
  body: ReturnType<typeof openaiToCohere>["cohereBody"];
  adapter: ReturnType<typeof makeCohereOpenaiAdapterFactory>;
};

type GeminiModelRouterProvider = {
  kind: "gemini";
  body: ReturnType<typeof openaiToGemini>["geminiBody"];
  adapter: ReturnType<typeof makeGeminiOpenaiAdapterFactory>;
};

type ModelRouterProvider =
  | OpenAiWireModelRouterProvider
  | AnthropicModelRouterProvider
  | BedrockModelRouterProvider
  | CohereModelRouterProvider
  | GeminiModelRouterProvider;

type TranslatedModelRouterProvider =
  | "anthropic"
  | "bedrock"
  | "cohere"
  | "gemini";

const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const RESPONSES_SUFFIX = "/responses";
const EMBEDDINGS_SUFFIX = "/embeddings";

// The router fronts every OpenAI-wire provider, and some (GitHub Copilot) omit
// or vary `object`/`created` on an otherwise valid completion. The strict
// OpenAI schema turned those into a 500 during response serialization. The
// Copilot schema is the OpenAI schema with those two fields relaxed and
// provider extensions passed through, so it accepts every standard reply too.
const ModelRouterChatCompletionResponseSchema =
  GithubCopilot.API.ChatCompletionResponseSchema;

const openAiWireProviders = {
  openai: openaiAdapterFactory,
  azure: azureAdapterFactory,
  cerebras: cerebrasAdapterFactory,
  deepseek: deepseekAdapterFactory,
  "github-copilot": githubCopilotAdapterFactory,
  groq: groqAdapterFactory,
  kimi: kimiAdapterFactory,
  "kimi-code": kimiCodeAdapterFactory,
  minimax: minimaxAdapterFactory,
  mistral: mistralAdapterFactory,
  ollama: ollamaAdapterFactory,
  openrouter: openrouterAdapterFactory,
  perplexity: perplexityAdapterFactory,
  vllm: vllmAdapterFactory,
  xai: xaiAdapterFactory,
  zhipuai: zhipuaiAdapterFactory,
} satisfies Partial<Record<SupportedProvider, unknown>> as Partial<
  Record<SupportedProvider, OpenAiWireProvider>
>;

const translatedModelRouterProviders = [
  "anthropic",
  "bedrock",
  "cohere",
  "gemini",
] as const satisfies ReadonlyArray<TranslatedModelRouterProvider>;

/**
 * Translated providers whose wire OpenAPPA does not read. Anthropic's
 * Messages wire is one OpenAPPA reads, so it is not here.
 */
const unreadTranslatedProviders: ReadonlySet<SupportedProvider> =
  new Set<TranslatedModelRouterProvider>(["bedrock", "cohere", "gemini"]);

/**
 * Built from the shared list so the connection UI cannot advertise the router
 * for a provider that 404s on it. The assertion below keeps that list honest
 * against the two maps that actually implement routing.
 */
const modelRouterSupportedProviders = new Set<SupportedProvider>(
  MODEL_ROUTER_SUPPORTED_PROVIDERS,
);

const implementedModelRouterProviders: SupportedProvider[] = [
  ...(Object.keys(openAiWireProviders) as SupportedProvider[]),
  ...translatedModelRouterProviders,
];
for (const provider of implementedModelRouterProviders) {
  if (!modelRouterSupportedProviders.has(provider)) {
    throw new Error(
      `[ModelRouterProxy] ${provider} is routable but missing from MODEL_ROUTER_SUPPORTED_PROVIDERS`,
    );
  }
}
for (const provider of modelRouterSupportedProviders) {
  if (!implementedModelRouterProviders.includes(provider)) {
    throw new Error(
      `[ModelRouterProxy] ${provider} is listed in MODEL_ROUTER_SUPPORTED_PROVIDERS but has no router implementation`,
    );
  }
}

const ModelListResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(
    z.object({
      id: z.string(),
      object: z.literal("model"),
      created: z.number(),
      owned_by: z.string(),
    }),
  ),
});

const modelRouterProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  logger.debug("[ModelRouterProxy] Registering model router routes");

  await registerMediaMultipartParser(fastify);
  for (const withAgent of [false, true]) {
    fastify.post(
      `${MODEL_ROUTER_PREFIX}${withAgent ? "/:agentId" : ""}/images/edits`,
      {
        bodyLimit: PROXY_BODY_LIMIT,
        onRequest: async (request) => {
          mediaAuth.set(request, await authenticateMediaRequest(request));
        },
        schema: {
          operationId: withAgent
            ? RouteId.ModelRouterImageEditsWithAgent
            : RouteId.ModelRouterImageEditsWithDefaultAgent,
          description:
            "Edit images through a mapped OpenAI, Azure or Gemini image model using bounded multipart reference images and an optional mask.",
          tags: ["LLM Proxy"],
          ...(withAgent ? { params: z.object({ agentId: UuidIdSchema }) } : {}),
          headers: OpenAi.API.ChatCompletionsHeadersSchema,
          consumes: ["multipart/form-data"],
          body: ImageEditMultipartBodySchema,
          response: constructResponseSchema(
            Azure.API.ImageGenerationResponseSchema,
          ),
        },
      },
      async (request, reply) => {
        const parsed = await parseImageEditRequest(request);
        const auth = mediaAuth.get(request);
        if (!auth)
          throw new ApiError(401, "Model Router authentication is required.");
        const resolution = await resolveModelRoute({
          requestedModel: parsed.body.model,
          capability: "media",
          allowedProviders: getMappedProviders(auth),
          allowedApiKeyIds: getMappedApiKeyIds(auth),
        });
        const provider = resolution.provider;
        if (
          provider !== "azure" &&
          provider !== "openai" &&
          provider !== "gemini"
        )
          throw new ApiError(
            400,
            `Provider "${provider}" does not support the Model Router image edits endpoint.`,
          );
        await applyModelRouterAuthOverride({ request, auth, resolution });
        parsed.body.model = resolution.modelId;
        return handleImageEdit({ parsed, provider, request, reply });
      },
    );
  }
  for (const operation of [
    "speech",
    "transcriptions",
    "translations",
  ] as const) {
    for (const withAgent of [false, true]) {
      fastify.post(
        `${MODEL_ROUTER_PREFIX}${withAgent ? "/:agentId" : ""}/audio/${operation}`,
        {
          bodyLimit: PROXY_BODY_LIMIT,
          // Authenticate before buffering multipart bytes, including agent access.
          onRequest: async (request) => {
            mediaAuth.set(request, await authenticateMediaRequest(request));
          },
          schema: {
            operationId: AUDIO_ROUTE_IDS[operation][withAgent ? 1 : 0],
            description:
              "Use mapped Azure or OpenAI credentials for governed native audio responses. Raw audio is excluded from interaction logs.",
            tags: ["LLM Proxy"],
            ...(withAgent
              ? { params: z.object({ agentId: UuidIdSchema }) }
              : {}),
            headers: OpenAi.API.ChatCompletionsHeadersSchema,
            ...(operation === "speech"
              ? { body: AudioSpeechRequestSchema }
              : {
                  consumes: ["multipart/form-data"],
                  body: AudioMultipartBodySchema,
                }),
          },
        },
        async (request, reply) => {
          const body =
            operation === "speech"
              ? (request.body as AudioProxyBody)
              : await parseAudioUploadRequest(request, operation);
          const auth = mediaAuth.get(request);
          if (!auth)
            throw new ApiError(401, "Model Router authentication is required.");
          const resolution = await resolveModelRoute({
            requestedModel: body.model,
            capability: "media",
            allowedProviders: getMappedProviders(auth),
            allowedApiKeyIds: getMappedApiKeyIds(auth),
          });
          if (
            resolution.provider !== "azure" &&
            resolution.provider !== "openai"
          ) {
            throw new ApiError(
              400,
              `Provider "${resolution.provider}" does not support the Model Router audio endpoint.`,
            );
          }
          await applyModelRouterAuthOverride({ request, auth, resolution });
          return handleAudioProxy({
            body: { ...body, model: resolution.modelId },
            request,
            reply,
            provider: resolution.provider,
            operation,
          });
        },
      );
    }
  }

  for (const withAgent of [false, true]) {
    fastify.post(
      `${MODEL_ROUTER_PREFIX}${withAgent ? "/:agentId" : ""}/images/generations`,
      {
        bodyLimit: PROXY_BODY_LIMIT,
        schema: {
          operationId: withAgent
            ? RouteId.ModelRouterImagesWithAgent
            : RouteId.ModelRouterImagesWithDefaultAgent,
          description:
            "Generate images through the OpenAI-compatible Model Router. Unsupported provider parameters and streaming are rejected.",
          tags: ["LLM Proxy"],
          ...(withAgent ? { params: z.object({ agentId: UuidIdSchema }) } : {}),
          body: Azure.API.ImageGenerationRequestSchema,
          headers: OpenAi.API.ChatCompletionsHeadersSchema,
          response: constructResponseSchema(
            Azure.API.ImageGenerationResponseSchema,
          ),
        },
      },
      routeImageGeneration,
    );
  }

  fastify.get(
    `${MODEL_ROUTER_PREFIX}/models`,
    {
      schema: {
        operationId: RouteId.ModelRouterListModelsWithDefaultAgent,
        description:
          "List OpenAI-compatible model ids available through the model router (default LLM proxy)",
        tags: ["LLM Proxy"],
        response: constructResponseSchema(ModelListResponseSchema),
      },
    },
    async (request, reply) => {
      const auth = await getModelRouterAuth(request);
      const agent = await getDefaultModelRouterAgent();
      await ensureModelRouterAgentAccess({ agent, auth });
      return reply.send(await listModels({ auth }));
    },
  );

  fastify.get(
    `${MODEL_ROUTER_PREFIX}/:agentId/models`,
    {
      schema: {
        operationId: RouteId.ModelRouterListModelsWithAgent,
        description:
          "List OpenAI-compatible model ids available through the model router (specific attribution Agent)",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        response: constructResponseSchema(ModelListResponseSchema),
      },
    },
    async (request, reply) => {
      const auth = await getModelRouterAuth(request);
      const agent = await getModelRouterAgent(request.params.agentId);
      await ensureModelRouterAgentAccess({ agent, auth });
      return reply.send(await listModels({ auth }));
    },
  );

  fastify.post(
    `${MODEL_ROUTER_PREFIX}${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.ModelRouterResponsesWithDefaultAgent,
        description:
          "Create a response through the OpenAI-compatible model router (default LLM proxy)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.ResponsesRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.ResponsesResponseSchema),
      },
    },
    async (request, reply) => {
      return withRouterTelemetry({
        request,
        reply,
        operation: "chat",
        run: () => routeResponse(request, reply),
      });
    },
  );

  fastify.post(
    `${MODEL_ROUTER_PREFIX}/:agentId${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.ModelRouterResponsesWithAgent,
        description:
          "Create a response through the OpenAI-compatible model router (specific attribution Agent)",
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
      return withRouterTelemetry({
        request,
        reply,
        operation: "chat",
        run: () => routeResponse(request, reply),
      });
    },
  );

  fastify.post(
    `${MODEL_ROUTER_PREFIX}${EMBEDDINGS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.ModelRouterEmbeddingsWithDefaultAgent,
        description:
          "Create embeddings through the OpenAI-compatible model router (default LLM proxy)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.EmbeddingRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(EmbeddingWireResponseSchema),
      },
    },
    async (request, reply) => {
      return withRouterTelemetry({
        request,
        reply,
        operation: "embedding",
        run: () => routeEmbedding(request, reply),
      });
    },
  );

  fastify.post(
    `${MODEL_ROUTER_PREFIX}/:agentId${EMBEDDINGS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.ModelRouterEmbeddingsWithAgent,
        description:
          "Create embeddings through the OpenAI-compatible model router (specific attribution Agent)",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.EmbeddingRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(EmbeddingWireResponseSchema),
      },
    },
    async (request, reply) => {
      return withRouterTelemetry({
        request,
        reply,
        operation: "embedding",
        run: () => routeEmbedding(request, reply),
      });
    },
  );

  fastify.post(
    `${MODEL_ROUTER_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.ModelRouterChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion through the OpenAI-compatible model router (default LLM proxy)",
        tags: ["LLM Proxy"],
        body: RouterChatRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          ModelRouterChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      return withRouterTelemetry({
        request,
        reply,
        operation: "chat",
        run: () => routeChatCompletion(request, reply),
      });
    },
  );

  fastify.post(
    `${MODEL_ROUTER_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.ModelRouterChatCompletionsWithAgent,
        description:
          "Create a chat completion through the OpenAI-compatible model router (specific attribution Agent)",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: RouterChatRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          ModelRouterChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      return withRouterTelemetry({
        request,
        reply,
        operation: "chat",
        run: () => routeChatCompletion(request, reply),
      });
    },
  );
};

export default modelRouterProxyRoutes;

const AUDIO_ROUTE_IDS = {
  speech: [
    RouteId.ModelRouterAudioSpeechWithDefaultAgent,
    RouteId.ModelRouterAudioSpeechWithAgent,
  ],
  transcriptions: [
    RouteId.ModelRouterAudioTranscriptionsWithDefaultAgent,
    RouteId.ModelRouterAudioTranscriptionsWithAgent,
  ],
  translations: [
    RouteId.ModelRouterAudioTranslationsWithDefaultAgent,
    RouteId.ModelRouterAudioTranslationsWithAgent,
  ],
} as const;

async function authenticateMediaRequest(
  request: FastifyRequest,
): Promise<ModelRouterAuth> {
  const auth = await getModelRouterAuth(request);
  const { agentId } = request.params as { agentId?: string };
  if (agentId && !UuidIdSchema.safeParse(agentId).success) {
    throw new ApiError(400, "Invalid LLM proxy id.");
  }
  const agent = agentId
    ? await getModelRouterAgent(agentId)
    : await getDefaultModelRouterAgent();
  await ensureModelRouterAgentAccess({ agent, auth });
  return auth;
}

async function routeImageGeneration(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const body = request.body as z.infer<
    typeof Azure.API.ImageGenerationRequestSchema
  >;
  const params = request.params as { agentId?: string };
  const auth = await getModelRouterAuth(request);
  const agent = params.agentId
    ? await getModelRouterAgent(params.agentId)
    : await getDefaultModelRouterAgent();
  await ensureModelRouterAgentAccess({ agent, auth });
  const resolution = await resolveModelRoute({
    requestedModel: body.model,
    capability: "media",
    allowedProviders: getMappedProviders(auth),
    allowedApiKeyIds: getMappedApiKeyIds(auth),
  });
  const routedBody = { ...body, model: resolution.modelId };
  await applyModelRouterAuthOverride({ request, auth, resolution });
  switch (resolution.provider) {
    case "azure":
      return handleLLMProxy(
        routedBody,
        request,
        reply,
        azureImagesAdapterFactory,
      );
    case "openai":
      return handleLLMProxy(
        routedBody,
        request,
        reply,
        openaiImagesAdapterFactory,
      );
    case "gemini":
      return handleLLMProxy(
        toGeminiImageRequest(routedBody),
        request,
        reply,
        geminiImagesAdapterFactory,
      );
    default:
      throw new ApiError(
        400,
        `Provider "${resolution.provider}" does not support the Model Router images endpoint.`,
      );
  }
}

async function withRouterTelemetry(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  operation: "chat" | "embedding";
  run: () => Promise<FastifyReply>;
}): Promise<FastifyReply> {
  const telemetry = getLlmProxyRequestTelemetry({
    request: params.request,
    provider: "router",
    operation: params.operation,
    stream: (params.request.body as { stream?: boolean })?.stream === true,
  });
  try {
    return await params.run();
  } catch (error) {
    telemetry.fail(classifyProxyFailure(error));
    throw error;
  } finally {
    telemetry.finish({
      statusCode: params.reply.statusCode,
      headersSent: params.reply.raw.headersSent,
      disconnected:
        params.reply.raw.destroyed && !params.reply.raw.writableEnded,
    });
  }
}

async function routeChatCompletion(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const body = request.body as OpenAi.Types.ChatCompletionsRequest;
  const params = request.params as { agentId?: string };
  const auth = await getModelRouterAuth(request);
  const agent = params.agentId
    ? await getModelRouterAgent(params.agentId)
    : await getDefaultModelRouterAgent();
  await ensureModelRouterAgentAccess({ agent, auth });
  const auto = await resolveAutoModel({
    request,
    auth,
    agent,
    endpoint: "chat_completions",
    requestedModel: body.model,
    body,
  });
  if (auto.kind === "usage_limited")
    return sendUsageLimitRefusal(reply, auto.violation);
  // A model pool's name is served by the pool's members, LiteLLM style: the
  // proxy picks a member and its key, when the caller may use the pool.
  const poolId =
    auto.kind === "as_requested"
      ? await usableModelPoolId({ auth, model: body.model })
      : null;
  if (poolId) {
    applyModelPoolAuthOverride({ request, auth, poolId });
    return handleLLMProxy(body, request, reply, openaiAdapterFactory);
  }
  const resolution = await resolveModelRoute({
    requestedModel: auto.model,
    allowedProviders: getMappedProviders(auth),
    allowedApiKeyIds: getMappedApiKeyIds(auth),
  });
  assertModelRouterCacheControls(resolution.provider, body);
  const routedBody = {
    ...body,
    model: resolution.modelId,
  };

  logger.info(
    {
      requestedModel: resolution.requestedModel,
      routedModel: resolution.modelId,
      provider: resolution.provider,
    },
    "[ModelRouterProxy] Resolved model route",
  );

  assertModelServesChatCompletions(resolution);

  scrubClientWireBeforeTranslation({
    request,
    provider: resolution.provider,
    family: "openai:chatCompletions",
    body: routedBody,
  });
  const provider = getOpenAiChatProviderForResolution({
    provider: resolution.provider,
    body: routedBody,
  });
  await applyModelRouterAuthOverride({
    request,
    auth,
    resolution,
  });

  return handleModelRouterProvider(provider, request, reply);
}

async function routeResponse(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as OpenAi.Types.ResponsesRequest;
  const params = request.params as { agentId?: string };
  const auth = await getModelRouterAuth(request);
  const agent = params.agentId
    ? await getModelRouterAgent(params.agentId)
    : await getDefaultModelRouterAgent();
  await ensureModelRouterAgentAccess({ agent, auth });
  const auto = await resolveAutoModel({
    request,
    auth,
    agent,
    endpoint: "responses",
    requestedModel: body.model,
    body,
  });
  if (auto.kind === "usage_limited")
    return sendUsageLimitRefusal(reply, auto.violation);
  const resolution = await resolveModelRoute({
    requestedModel: auto.model,
    allowedProviders: getMappedProviders(auth),
    allowedApiKeyIds: getMappedApiKeyIds(auth),
  });

  assertModelRouterCacheControls(resolution.provider, body);

  // Preserve native Responses semantics whenever that surface is available.
  // A chat round trip loses reasoning settings, encrypted replay state,
  // assistant phases and tools that are not Chat Completions functions.
  const selectedKey = await applyModelRouterAuthOverride({
    request,
    auth,
    resolution,
  });
  const nativeResponsesAdapter = await getNativeResponsesAdapter({
    resolution,
    providerApiKeyId: selectedKey.providerApiKeyId,
  });
  if (nativeResponsesAdapter) {
    return handleLLMProxy(
      { ...body, model: resolution.modelId },
      request,
      reply,
      nativeResponsesAdapter,
    );
  }

  // The shared list keeps this refusal, the model picker and the runtime
  // launch preflight in agreement: see CHAT_COMPLETIONS_ONLY_ROUTER_PROVIDERS.
  if (isChatCompletionsOnlyRouterProvider(resolution.provider)) {
    throw new ApiError(
      501,
      `${providerDisplayNames[resolution.provider]} models are available through the model router's Chat Completions endpoint only: the Responses translation cannot carry the reasoning their thinking models need on tool-call turns.`,
    );
  }

  // The translation joins a message's text parts into one string, which can
  // leave a client's delegation marker mid-text (Kilo Code appends an
  // environment part after the prompt it was handed). Collect the markers
  // from the wire the client sent, where each still ends its own part.
  setCollectedDelegationMarkers(
    request,
    collectDelegationMarkers({ family: "openai:responses", body }),
  );
  // The translation also joins an OpenCode-family subagent return with the
  // parts beside it, so returns are read from the client's wire too.
  scrubClientWireBeforeTranslation({
    request,
    provider: resolution.provider,
    family: "openai:responses",
    body,
  });
  const { chatBody, responsesContext } = responsesToOpenaiChat(body, {
    preserveContentParts:
      resolution.provider === "bedrock" || resolution.provider === "anthropic",
  });
  const routedChatBody = {
    ...chatBody,
    model: resolution.modelId,
  };

  const provider = getOpenAiChatProviderForResolution({
    provider: resolution.provider,
    body: routedChatBody,
  });
  await applyModelRouterAuthOverride({
    request,
    auth,
    resolution,
  });

  return handleModelRouterResponsesProvider(
    provider,
    responsesContext,
    request,
    reply,
  );
}

async function routeEmbedding(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as OpenAi.Types.EmbeddingRequest;
  const params = request.params as { agentId?: string };
  const auth = await getModelRouterAuth(request);
  const agent = params.agentId
    ? await getModelRouterAgent(params.agentId)
    : await getDefaultModelRouterAgent();
  await ensureModelRouterAgentAccess({ agent, auth });
  const resolution = await resolveModelRoute({
    requestedModel: body.model,
    capability: "embeddings",
    allowedProviders: getMappedProviders(auth),
    allowedApiKeyIds: getMappedApiKeyIds(auth),
  });

  const embeddingsProvider = getModelRouterEmbeddingsProvider(
    resolution.provider,
  );

  const routedBody = {
    ...body,
    model: resolution.modelId,
  };

  await applyModelRouterAuthOverride({
    request,
    auth,
    resolution,
  });

  return handleLLMProxy(
    routedBody,
    request,
    reply,
    withEmbeddingEncoding(embeddingsProvider, body.encoding_format),
  );
}

/**
 * Resolve the embeddings adapter for a routed provider.
 *
 * - Gemini uses its native embedding API via a translation adapter.
 * - Every OpenAI-wire provider (openai, mistral, azure, ollama, vllm, zhipuai, …)
 *   exposes an OpenAI-compatible `/embeddings` endpoint, so they share the
 *   OpenAI-compatible embeddings adapter (only the provider name and default
 *   base URL differ; the effective base URL still comes from the mapped key).
 *
 * Providers reach this dispatch only when the model router resolved a
 * provider-qualified embedding model registered for them, so unsupported
 * providers surface a clear 501 rather than a misrouted request.
 */
function getModelRouterEmbeddingsProvider(
  provider: SupportedProvider,
): EmbeddingsModelRouterProvider {
  if (provider === "gemini") {
    return geminiEmbeddingsAdapterFactory;
  }
  if (provider === "openai") {
    return openAiEmbeddingsAdapterFactory;
  }
  if (provider === "azure") {
    return azureEmbeddingsAdapterFactory;
  }
  // Copilot is an OpenAI-wire chat provider but publishes no embeddings models,
  // and the generic OpenAI-compatible embeddings adapter would send the raw
  // GitHub OAuth token upstream instead of exchanging it for a Copilot bearer.
  // Resolution should never reach here for it; fall through to the 501 if it
  // somehow does rather than emit a request that leaks the token.
  if (provider !== "github-copilot" && provider in openAiWireProviders) {
    return makeOpenAiCompatibleEmbeddingsAdapterFactory(provider, () =>
      getProviderConfiguredBaseUrl(provider),
    );
  }
  throw new ApiError(
    501,
    `Provider "${provider}" is not yet available through the OpenAI-compatible model router embeddings endpoint.`,
  );
}

/**
 * Prefer a provider's native Responses surface whenever one serves the model;
 * other providers keep the chat translation.
 */
async function getNativeResponsesAdapter({
  resolution,
  providerApiKeyId,
}: {
  resolution: ModelRouterResolution;
  providerApiKeyId: string;
}) {
  if (resolution.provider === "azure") {
    const evidence = await resolveAzureModelCapabilities({
      providerApiKeyId,
      modelId: resolution.modelId,
    });
    // This is an explicit Responses request. Unknown deployment identities are
    // sent to that native surface so Azure validates them; aliases never imply
    // a backing model or permission to translate across APIs.
    return evidence.status !== "known" ||
      (evidence.underlyingModelName &&
        isAzureOpenAiFirstPartyModelName(evidence.underlyingModelName))
      ? azureResponsesAdapterFactory
      : null;
  }
  switch (nativeResponsesProvider(resolution)) {
    case "openai":
      return openAiResponsesAdapterFactory;
    case "azure":
      return azureResponsesAdapterFactory;
    case "github-copilot":
      return githubCopilotResponsesAdapterFactory;
    case null:
      return null;
  }
}

/**
 * Rejects a model the provider has no chat-completions endpoint for locally.
 * The request would otherwise reach a provider that answers with its own
 * opaque "model not supported" error, which says nothing about the endpoint
 * being the problem. A model the provider serves there, even only without
 * function tools, is forwarded so the router answers as the provider does.
 */
function assertModelServesChatCompletions(
  resolution: ModelRouterResolution,
): void {
  if (
    !requiresResponsesApi(resolution.supportedEndpoints) &&
    !(
      resolution.provider === "openai" &&
      lacksOpenAiChatCompletions(resolution.modelId)
    )
  ) {
    return;
  }
  throw new ApiError(
    400,
    `Model "${resolution.requestedModel}" is only served over the Responses API. ` +
      `Send this request to the model router's ${RESPONSES_SUFFIX} endpoint instead of ${CHAT_COMPLETIONS_SUFFIX}.`,
  );
}

function getOpenAiChatProviderForResolution(params: {
  provider: SupportedProvider;
  body: OpenAi.Types.ChatCompletionsRequest;
}): ModelRouterProvider {
  const provider = openAiWireProviders[params.provider];
  if (provider) {
    return { kind: "openai-wire", body: params.body, adapter: provider };
  }

  if (isTranslatedModelRouterProvider(params.provider)) {
    return getTranslatedModelRouterProvider({
      provider: params.provider,
      body: params.body,
    });
  }

  throw new ApiError(
    501,
    `Provider "${params.provider}" is not yet available through the OpenAI-compatible model router.`,
  );
}

/**
 * OpenAPPA reads the client's Responses and Chat Completions wires but not the
 * Gemini, Bedrock Converse or Cohere wire, so a request translated to one of
 * those would reach it with no session and no subagent returns it can check.
 * It scrubs the client's body here instead, before the translation, which
 * then forwards the scrubbed body.
 */
function scrubClientWireBeforeTranslation(params: {
  request: FastifyRequest;
  provider: SupportedProvider;
  family: "openai:responses" | "openai:chatCompletions";
  body: OpenAi.Types.ChatCompletionsRequest | OpenAi.Types.ResponsesRequest;
}): void {
  if (!unreadTranslatedProviders.has(params.provider)) return;
  scrubTranslatedClientWire({
    request: params.request,
    family: params.family,
    body: params.body,
    // Gemini's ids carry the call's thought signature on the client's wire
    // only; the translated body names the call by its own id.
    ...(params.provider === "gemini"
      ? {
          translatedCallId: (callId: string) =>
            decodeSignedToolCallId(callId).id ?? callId,
        }
      : {}),
  });
}

function getTranslatedModelRouterProvider(params: {
  provider: TranslatedModelRouterProvider;
  body: OpenAi.Types.ChatCompletionsRequest;
}): ModelRouterProvider {
  switch (params.provider) {
    case "anthropic": {
      const { anthropicBody, openaiContext } = openaiToAnthropic(params.body);
      return {
        kind: "anthropic",
        body: anthropicBody,
        adapter: makeAnthropicOpenaiAdapterFactory(openaiContext),
      };
    }
    case "bedrock": {
      const { converseBody, openaiContext } = openaiToConverse(params.body);
      return {
        kind: "bedrock",
        body: converseBody,
        adapter: makeBedrockOpenaiAdapterFactory(openaiContext),
      };
    }
    case "cohere": {
      const { cohereBody, openaiContext } = openaiToCohere(params.body);
      return {
        kind: "cohere",
        body: cohereBody,
        adapter: makeCohereOpenaiAdapterFactory(openaiContext),
      };
    }
    case "gemini": {
      const { geminiBody, openaiContext } = openaiToGemini(params.body);
      return {
        kind: "gemini",
        body: geminiBody,
        adapter: makeGeminiOpenaiAdapterFactory(openaiContext),
      };
    }
    default:
      return assertNever(params.provider);
  }
}

function handleModelRouterProvider(
  provider: ModelRouterProvider,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  switch (provider.kind) {
    case "openai-wire":
      return handleLLMProxy(provider.body, request, reply, provider.adapter);
    case "anthropic":
      return handleLLMProxy(provider.body, request, reply, provider.adapter);
    case "bedrock":
      return handleLLMProxy(provider.body, request, reply, provider.adapter);
    case "cohere":
      return handleLLMProxy(provider.body, request, reply, provider.adapter);
    case "gemini":
      return handleLLMProxy(provider.body, request, reply, provider.adapter);
  }
}

function handleModelRouterResponsesProvider(
  provider: ModelRouterProvider,
  responsesContext: OpenaiResponsesContext,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  switch (provider.kind) {
    case "openai-wire":
      return handleLLMProxy(
        provider.body,
        request,
        reply,
        makeResponsesFromChatAdapterFactory(provider.adapter, responsesContext),
      );
    case "anthropic":
      return handleLLMProxy(
        provider.body,
        request,
        reply,
        makeResponsesFromChatAdapterFactory(provider.adapter, responsesContext),
      );
    case "bedrock":
      return handleLLMProxy(
        provider.body,
        request,
        reply,
        makeResponsesFromChatAdapterFactory(provider.adapter, responsesContext),
      );
    case "cohere":
      return handleLLMProxy(
        provider.body,
        request,
        reply,
        makeResponsesFromChatAdapterFactory(provider.adapter, responsesContext),
      );
    case "gemini":
      return handleLLMProxy(
        provider.body,
        request,
        reply,
        makeResponsesFromChatAdapterFactory(provider.adapter, responsesContext),
      );
  }
}

async function listModels(params: { auth: ModelRouterAuth }) {
  // Hide models the caller cannot invoke, mirroring the proxy-time check: a
  // user-attributed credential needs a `use` grant; auth without a user
  // identity may exercise only an organization-wide grant.
  const chatModels = await listRoutableModels({
    organizationId: params.auth.organizationId,
    providerApiKeyIds: params.auth.providerApiKeys
      .filter((mapping) => modelRouterSupportedProviders.has(mapping.provider))
      .map((mapping) => mapping.providerApiKeyId),
    userId:
      params.auth.authMethod === "oauth_user"
        ? params.auth.userId
        : params.auth.serviceAccountId
          ? serviceAccountUserId(params.auth.serviceAccountId)
          : undefined,
    includeEmbeddings: true,
    includeMedia: true,
  });
  // Pools come first: their names are what clients are meant to ask for.
  const pools = (
    config.llmProxy.modelPoolsEnabled
      ? await ModelPoolModel.list(params.auth.organizationId)
      : []
  ).filter(
    (pool) =>
      pool.members.some((member) => member.enabled) &&
      mayUseModelPool({ pool, caller: modelPoolCaller(params.auth) }),
  );

  const autoModel = (await autoModelAvailable(params.auth))
    ? [
        {
          id: AUTO_MODEL,
          object: "model" as const,
          created: 0,
          owned_by: "archestra",
        },
      ]
    : [];
  return {
    object: "list" as const,
    data: [
      ...pools.map((pool) => ({
        id: pool.name,
        object: "model" as const,
        created: Math.floor(pool.createdAt.getTime() / 1000),
        owned_by: "model-pool",
      })),
      ...autoModel,
      ...chatModels.map((model) => ({
        id: buildRoutableModelId(model),
        object: "model" as const,
        created: Math.floor(model.createdAt.getTime() / 1000),
        owned_by: model.provider,
      })),
    ],
  };
}

export async function getModelRouterAgent(agentId: string | undefined) {
  const agent = await resolveAgent(agentId);
  if (agent.agentType !== "llm_proxy" && agent.agentType !== "agent") {
    throw new ApiError(400, "Model router requires an Agent or LLM Proxy ID.");
  }
  return agent;
}

async function getDefaultModelRouterAgent() {
  return getModelRouterAgent(undefined);
}

export async function ensureModelRouterAgentAccess(params: {
  agent: GatewayAgent;
  auth: ModelRouterAuth;
}) {
  if (params.agent.organizationId !== params.auth.organizationId) {
    throw new ApiError(
      403,
      "Model Router virtual key cannot access this Agent.",
    );
  }
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  if (
    params.auth.serviceAccountId &&
    !(params.agent.agentType === "llm_proxy" && params.agent.isDefault)
  ) {
    const userId = serviceAccountUserId(params.auth.serviceAccountId);
    if (
      !(await AgentTeamModel.userHasAgentAccess({
        userId,
        agentId: params.agent.id,
        agentAccessContext: params.agent,
        action: "use",
        isAgentAdmin: await ResourcePermissions.allows({
          userId,
          organizationId: params.agent.organizationId,
          resource: "agent",
          scope: "*",
          action: "update",
        }),
      }))
    )
      throw new ApiError(403, "Service account cannot access this Agent.");
  }
  // SPDX-SnippetEnd
  if (params.auth.authMethod === "oauth_user") {
    const member = await MemberModel.getByUserId(
      params.auth.userId,
      params.agent.organizationId,
    );
    if (!member) {
      throw new ApiError(403, "OAuth user cannot access this Agent.");
    }
  }
}

async function getModelRouterAuth(
  request: FastifyRequest,
): Promise<ModelRouterAuth> {
  return authenticateModelRouterBearer({
    authorization: request.raw.headers.authorization,
    ip: request.ip,
  });
}

/**
 * The Model Router's credential check on its own, for a request that is not
 * a Fastify request: a WebSocket upgrade carries the same bearer token.
 */
export async function authenticateModelRouterBearer(params: {
  authorization: string | undefined;
  ip: string;
}): Promise<ModelRouterAuth> {
  const rawAuthHeader = params.authorization;
  const tokenMatch = rawAuthHeader?.match(/^Bearer\s+(.+)$/i);
  const bearerToken = tokenMatch?.[1];
  if (!bearerToken) {
    throw new ApiError(
      401,
      "Model router requests require a mapped virtual API key or LLM OAuth client access token.",
    );
  }

  if (!hasArchestraTokenPrefix(bearerToken)) {
    return getModelRouterOAuthClientAuth(bearerToken);
  }

  await virtualKeyRateLimiter.check({
    ip: params.ip,
    credential: bearerToken,
  });
  try {
    const resolved = await validateVirtualApiKeyToken(bearerToken);
    if (resolved.virtualKey.createdByServiceAccountId)
      await resolveOauthServiceAccount({
        serviceAccountId: resolved.virtualKey.createdByServiceAccountId,
        organizationId: resolved.virtualKey.organizationId,
      });
    const mappings = await resolveVirtualKeyProviderMappings(
      resolved.virtualKey.id,
    );
    if (mappings.length === 0) {
      throw new ApiError(
        401,
        "Virtual API key has no provider API keys configured.",
      );
    }

    await virtualKeyRateLimiter.recordSuccess({ credential: bearerToken });

    return {
      authMethod: "virtual_key",
      organizationId: resolved.virtualKey.organizationId,
      virtualKeyId: resolved.virtualKey.id,
      virtualKeyIsPersonal: await VirtualApiKeyModel.isPersonal(
        resolved.virtualKey,
      ),
      virtualKeyAuthorId: resolved.virtualKey.authorId,
      serviceAccountId:
        resolved.virtualKey.createdByServiceAccountId ?? undefined,
      billingTeamId: resolved.virtualKey.billingTeamId,
      providerApiKeys: mappings,
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) {
      try {
        await virtualKeyRateLimiter.recordFailure({
          ip: params.ip,
          credential: bearerToken,
        });
      } catch (rateLimitError) {
        logger.warn(
          {
            error:
              rateLimitError instanceof Error
                ? rateLimitError.message
                : String(rateLimitError),
          },
          "[ModelRouterProxy] Failed to record virtual key auth failure",
        );
      }
    }
    throw error;
  }
}

export function getMappedProviders(
  auth: ModelRouterAuth,
): Set<SupportedProvider> {
  return new Set(auth.providerApiKeys.map((mapping) => mapping.provider));
}

export function getMappedApiKeyIds(auth: ModelRouterAuth): string[] {
  return auth.providerApiKeys.map((mapping) => mapping.providerApiKeyId);
}

function isTranslatedModelRouterProvider(
  provider: SupportedProvider,
): provider is TranslatedModelRouterProvider {
  return translatedModelRouterProviders.includes(
    provider as TranslatedModelRouterProvider,
  );
}

function assertNever(value: never): never {
  throw new ApiError(500, `Unhandled model router provider "${value}".`);
}

/** The pool named `model` when the caller may use it and it has members. */
async function usableModelPoolId(params: {
  auth: ModelRouterAuth;
  model: string;
}): Promise<string | null> {
  if (!config.llmProxy.modelPoolsEnabled) return null;
  const pool = await ModelPoolModel.findByName({
    organizationId: params.auth.organizationId,
    name: params.model.trim(),
  });
  if (!pool || pool.members.length === 0) return null;
  return mayUseModelPool({ pool, caller: modelPoolCaller(params.auth) })
    ? pool.id
    : null;
}

function modelPoolCaller(auth: ModelRouterAuth): ModelPoolCaller {
  return {
    virtualKeyId:
      auth.authMethod === "virtual_key" ? auth.virtualKeyId : undefined,
    providerApiKeyIds: getMappedApiKeyIds(auth),
    modelPoolIds:
      auth.authMethod === "oauth_client_credentials"
        ? auth.modelPoolIds
        : undefined,
  };
}

function applyModelPoolAuthOverride(params: {
  request: FastifyRequest;
  auth: ModelRouterAuth;
  poolId: string;
}): void {
  (
    params.request as FastifyRequest & {
      llmProxyAuthOverride?: LLMProxyAuthOverride;
    }
  ).llmProxyAuthOverride = {
    apiKey: undefined,
    baseUrl: undefined,
    ...modelRouterCaller(params.auth),
    modelPoolId: params.poolId,
  };
}

async function applyModelRouterAuthOverride(params: {
  request: FastifyRequest;
  auth: ModelRouterAuth;
  resolution: ModelRouterResolution;
}): Promise<ModelRouterMappedProviderKey> {
  rejectUnsupportedProxyFileReferences(params.request.body);
  const credential = await selectModelRouterCredential(params);
  if (credential.kind === "denied") throw credential.error;
  const { mappedApiKey, apiKey } = credential;
  (
    params.request as FastifyRequest & {
      llmProxyAuthOverride?: LLMProxyAuthOverride;
    }
  ).llmProxyAuthOverride = {
    apiKey,
    baseUrl: mappedApiKey.baseUrl ?? undefined,
    chatApiKeyId: mappedApiKey.providerApiKeyId,
    ...modelRouterCaller(params.auth),
  };
  return mappedApiKey;
}

function modelRouterCaller(
  auth: ModelRouterAuth,
): Omit<LLMProxyAuthOverride, "apiKey" | "baseUrl" | "chatApiKeyId"> {
  return {
    authenticated: true,
    source: "model_router",
    authMethod: auth.authMethod,
    serviceAccountId: auth.serviceAccountId,
    virtualKeyId:
      auth.authMethod === "virtual_key" ? auth.virtualKeyId : undefined,
    authenticatedApp:
      auth.authMethod === "oauth_user"
        ? (auth.oauthClient ?? undefined)
        : auth.oauthClient,
    userId: modelRouterAuthenticatedUserId(auth),
    billingTeamId:
      auth.authMethod === "oauth_user"
        ? undefined
        : (auth.billingTeamId ?? undefined),
  };
}

async function getModelRouterOAuthClientAuth(
  bearerToken: string,
): Promise<ModelRouterOAuthClientAuth | ModelRouterUserOAuthAuth> {
  const accessToken = await OAuthAccessTokenModel.getByTokenHash(
    OAuthAccessTokenModel.hashTokenForLookup(bearerToken),
  );
  if (
    !accessToken ||
    accessToken.expiresAt < new Date() ||
    accessToken.refreshTokenRevoked
  ) {
    throw new ApiError(401, "Invalid LLM OAuth client access token.");
  }
  if (isAppConnectorAudienceRef(accessToken.referenceId)) {
    throw new ApiError(403, "Access token is bound to an app connector.");
  }
  if (!accessToken.scopes?.some((scope) => scope === LLM_PROXY_OAUTH_SCOPE)) {
    throw new ApiError(403, "Access token is missing Model Router scope.");
  }
  const managedClient = await LlmOauthClientModel.findByClientId(
    accessToken.clientId,
  );
  if (managedClient?.disabled) {
    throw new ApiError(401, "LLM OAuth client is disabled.");
  }
  if (managedClient && !managedClient.scopes.includes(LLM_PROXY_OAUTH_SCOPE)) {
    throw new ApiError(403, "OAuth client no longer grants LLM proxy access.");
  }
  if (accessToken.userId) {
    return getModelRouterUserOAuthAuth({ accessToken });
  }

  const oauthClient = await LlmOauthClientModel.findByClientId(
    accessToken.clientId,
  );
  if (!oauthClient) {
    throw new ApiError(401, "LLM OAuth client is no longer available.");
  }
  if (oauthClient.disabled) {
    throw new ApiError(401, "LLM OAuth client is disabled.");
  }

  if (oauthClient.serviceAccountId)
    await resolveOauthServiceAccount({
      serviceAccountId: oauthClient.serviceAccountId,
      organizationId: oauthClient.organizationId,
    });
  const mappings = await resolveOauthClientProviderMappings(oauthClient);
  const providerApiKeys = await LlmProviderApiKeyModel.findByIds(
    mappings.map((mapping) => mapping.providerApiKeyId),
  );
  const providerApiKeysById = new Map(
    providerApiKeys.map((apiKey) => [apiKey.id, apiKey]),
  );

  return {
    authMethod: "oauth_client_credentials",
    serviceAccountId: oauthClient.serviceAccountId ?? undefined,
    organizationId: oauthClient.organizationId,
    billingTeamId: oauthClient.billingTeamId,
    modelPoolIds: oauthClient.modelPoolIds,
    oauthClient: {
      id: oauthClient.id,
      name: oauthClient.name,
      clientId: oauthClient.clientId,
    },
    providerApiKeys: mappings.map((mapping) => {
      const apiKey = providerApiKeysById.get(mapping.providerApiKeyId);
      if (!apiKey) {
        throw new ApiError(
          500,
          "LLM OAuth client references a missing provider API key.",
        );
      }
      return {
        provider: mapping.provider,
        providerApiKeyId: apiKey.id,
        providerApiKeyName: apiKey.name,
        secretId: apiKey.secretId,
        baseUrl: apiKey.inferenceBaseUrl ?? apiKey.baseUrl,
        scope: apiKey.scope,
        userId: apiKey.userId,
      };
    }),
  };
}

async function getModelRouterUserOAuthAuth(params: {
  accessToken: NonNullable<
    Awaited<ReturnType<typeof OAuthAccessTokenModel.getByTokenHash>>
  >;
}): Promise<ModelRouterUserOAuthAuth> {
  if (!params.accessToken.userId) {
    throw new ApiError(401, "Invalid OAuth user access token.");
  }

  const member = await MemberModel.getFirstMembershipForUser(
    params.accessToken.userId,
  );
  if (!member) {
    throw new ApiError(401, "OAuth user is no longer available.");
  }

  const providerApiKeys = await userProviderKeyMappings({
    organizationId: member.organizationId,
    userId: params.accessToken.userId,
  });
  if (providerApiKeys.length === 0) {
    throw new ApiError(
      401,
      "OAuth user has no provider API keys available for Model Router usage.",
    );
  }
  const oauthClient = await OAuthClientModel.findByClientId(
    params.accessToken.clientId,
  );

  return {
    authMethod: "oauth_user",
    organizationId: member.organizationId,
    userId: params.accessToken.userId,
    providerApiKeys,
    oauthClient: oauthClient
      ? {
          id: oauthClient.id,
          name: oauthClient.name ?? oauthClient.clientId,
          clientId: oauthClient.clientId,
        }
      : null,
  };
}

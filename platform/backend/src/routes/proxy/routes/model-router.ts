import {
  credentialRequiresPerUserScope,
  hasArchestraTokenPrefix,
  LLM_PROXY_OAUTH_SCOPE,
  MODEL_ROUTER_SUPPORTED_PROVIDERS,
  perUserCredentialLabel,
  type ResourceVisibilityScope,
  RouteId,
  requiresOpenAiResponsesApi,
  requiresResponsesApi,
  type SupportedProvider,
} from "@archestra/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getProviderConfiguredBaseUrl } from "@/config";
import logger from "@/logging";
import {
  LlmOauthClientModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  MemberModel,
  ModelModel,
  ModelTeamModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  TeamModel,
  VirtualApiKeyModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { isAppConnectorAudienceRef } from "@/services/apps/app-connector-resource";
import { assertSubscriptionCredentialForProvider } from "@/services/subscription-credential-guard";
import type { GatewayAgent, LLMProvider } from "@/types";
import {
  ApiError,
  constructResponseSchema,
  OpenAi,
  UuidIdSchema,
} from "@/types";
import {
  azureAdapterFactory,
  cerebrasAdapterFactory,
  deepseekAdapterFactory,
  geminiEmbeddingsAdapterFactory,
  githubCopilotAdapterFactory,
  githubCopilotResponsesAdapterFactory,
  groqAdapterFactory,
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
import { makeBedrockOpenaiAdapterFactory } from "../adapters/bedrock-openai";
import { openaiToConverse } from "../adapters/bedrock-openai-translator";
import { makeCohereOpenaiAdapterFactory } from "../adapters/cohere-openai";
import { openaiToCohere } from "../adapters/cohere-openai-translator";
import { makeGeminiOpenaiAdapterFactory } from "../adapters/gemini-openai";
import { openaiToGemini } from "../adapters/gemini-openai-translator";
import { makeResponsesFromChatAdapterFactory } from "../adapters/openai-responses-from-chat";
import {
  type OpenaiResponsesContext,
  responsesToOpenaiChat,
} from "../adapters/openai-responses-translator";
import { MODEL_ROUTER_PREFIX, PROXY_BODY_LIMIT } from "../common";
import {
  resolveAgent,
  validateVirtualApiKeyToken,
  virtualKeyRateLimiter,
} from "../llm-proxy-auth";
import {
  handleLLMProxy,
  type LLMProxyAuthOverride,
} from "../llm-proxy-handler";
import {
  buildRoutableModelId,
  type ModelRouterResolution,
  resolveModelRoute,
  sortRoutableModels,
} from "../model-router-resolver";

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

type ModelRouterMappedProviderKey = {
  provider: SupportedProvider;
  providerApiKeyId: string;
  providerApiKeyName: string;
  secretId: string | null;
  baseUrl: string | null;
  scope: ResourceVisibilityScope;
  userId: string | null;
};

type ModelRouterUserProviderKey = Awaited<
  ReturnType<typeof LlmProviderApiKeyModel.getAvailableKeysForUser>
>[number];

type ModelRouterVirtualKeyAuth = {
  authMethod: "virtual_key";
  organizationId: string;
  virtualKeyScope: ResourceVisibilityScope;
  virtualKeyAuthorId: string | null;
  providerApiKeysByProvider: Map<
    SupportedProvider,
    ModelRouterMappedProviderKey
  >;
  oauthClient?: never;
};

type ModelRouterOAuthClientAuth = {
  authMethod: "oauth_client_credentials";
  organizationId: string;
  providerApiKeysByProvider: Map<
    SupportedProvider,
    ModelRouterMappedProviderKey
  >;
  oauthClient: {
    id: string;
    name: string;
    clientId: string;
  };
};

type ModelRouterUserOAuthAuth = {
  authMethod: "oauth_user";
  organizationId: string;
  userId: string;
  providerApiKeysByProvider: Map<
    SupportedProvider,
    ModelRouterMappedProviderKey
  >;
  oauthClient: {
    id: string;
    name: string;
    clientId: string;
  } | null;
};

type ModelRouterAuth =
  | ModelRouterVirtualKeyAuth
  | ModelRouterOAuthClientAuth
  | ModelRouterUserOAuthAuth;

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

const openAiWireProviders = {
  openai: openaiAdapterFactory,
  azure: azureAdapterFactory,
  cerebras: cerebrasAdapterFactory,
  deepseek: deepseekAdapterFactory,
  "github-copilot": githubCopilotAdapterFactory,
  groq: groqAdapterFactory,
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
  logger.info("[ModelRouterProxy] Registering model router routes");

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
      return routeResponse(request, reply);
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
      return routeResponse(request, reply);
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
        response: constructResponseSchema(OpenAi.API.EmbeddingResponseSchema),
      },
    },
    async (request, reply) => {
      return routeEmbedding(request, reply);
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
        response: constructResponseSchema(OpenAi.API.EmbeddingResponseSchema),
      },
    },
    async (request, reply) => {
      return routeEmbedding(request, reply);
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
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenAi.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      return routeChatCompletion(request, reply);
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
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenAi.API.ChatCompletionResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      return routeChatCompletion(request, reply);
    },
  );
};

export default modelRouterProxyRoutes;

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
  const resolution = await resolveModelRoute({
    requestedModel: body.model,
    allowedProviders: getMappedProviders(auth),
    allowedApiKeyIds: getMappedApiKeyIds(auth),
  });
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

  const provider = getOpenAiChatProviderForResolution({
    provider: resolution.provider,
    body: routedBody,
  });
  await applyModelRouterAuthOverride({
    request,
    auth,
    provider: resolution.provider,
  });

  return handleModelRouterProvider(provider, request, reply);
}

async function routeResponse(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as OpenAi.Types.ResponsesRequest;
  const { chatBody, responsesContext } = responsesToOpenaiChat(body);
  const params = request.params as { agentId?: string };
  const auth = await getModelRouterAuth(request);
  const agent = params.agentId
    ? await getModelRouterAgent(params.agentId)
    : await getDefaultModelRouterAgent();
  await ensureModelRouterAgentAccess({ agent, auth });
  const resolution = await resolveModelRoute({
    requestedModel: chatBody.model,
    allowedProviders: getMappedProviders(auth),
    allowedApiKeyIds: getMappedApiKeyIds(auth),
  });

  // A model its provider serves ONLY over Responses cannot survive the
  // responses→chat→responses round trip the uniform path uses, so hand the
  // caller's original Responses body to the provider's native Responses
  // adapter untouched.
  const nativeResponsesAdapter = getNativeResponsesAdapter(resolution);
  if (nativeResponsesAdapter) {
    await applyModelRouterAuthOverride({
      request,
      auth,
      provider: resolution.provider,
    });
    return handleLLMProxy(
      { ...body, model: resolution.modelId },
      request,
      reply,
      nativeResponsesAdapter,
    );
  }

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
    provider: resolution.provider,
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
    provider: resolution.provider,
  });

  return handleLLMProxy(routedBody, request, reply, embeddingsProvider);
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
 * The provider's native Responses adapter when the resolved model is served
 * only over Responses, otherwise null.
 *
 * Keyed off the model's published surfaces where available. OpenAI does not
 * publish those surfaces, so its known Responses-only model families use the
 * same model-id discriminator as foreground Agent chat.
 */
function getNativeResponsesAdapter(resolution: ModelRouterResolution) {
  if (!modelRequiresResponses(resolution)) {
    return null;
  }
  if (resolution.provider === "github-copilot") {
    return githubCopilotResponsesAdapterFactory;
  }
  if (resolution.provider === "openai") {
    return openAiResponsesAdapterFactory;
  }
  return null;
}

/**
 * Rejects a Responses-only model on the chat-completions endpoint locally. The
 * request would otherwise reach a provider that answers with its own opaque
 * "model not supported" error, which says nothing about the endpoint being the
 * problem.
 */
function assertModelServesChatCompletions(
  resolution: ModelRouterResolution,
): void {
  if (!modelRequiresResponses(resolution)) {
    return;
  }
  throw new ApiError(
    400,
    `Model "${resolution.requestedModel}" is only served over the Responses API. ` +
      `Send this request to the model router's ${RESPONSES_SUFFIX} endpoint instead of ${CHAT_COMPLETIONS_SUFFIX}.`,
  );
}

function modelRequiresResponses(resolution: ModelRouterResolution): boolean {
  return (
    requiresResponsesApi(resolution.supportedEndpoints) ||
    (resolution.provider === "openai" &&
      requiresOpenAiResponsesApi(resolution.modelId))
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
  const apiKeyIds = [...params.auth.providerApiKeysByProvider.values()]
    .filter((mapping) => modelRouterSupportedProviders.has(mapping.provider))
    .map((mapping) => mapping.providerApiKeyId);
  const linkedModels =
    await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds(apiKeyIds);
  const candidateModels = linkedModels
    .map(({ model }) => model)
    .filter((model) => {
      if (!modelRouterSupportedProviders.has(model.provider)) {
        return false;
      }
      return (
        ModelModel.supportsTextChat(model) ||
        ModelModel.supportsEmbeddings(model)
      );
    });

  // Hide team-restricted models the caller cannot invoke: user-attributed auth
  // is filtered by the user's team memberships (mirroring the proxy-time
  // guard); auth without a user identity cannot satisfy a team restriction,
  // so restricted models are omitted entirely.
  const allowedModelIds = await ModelTeamModel.filterAllowedModelIds({
    modelIds: candidateModels.map((model) => model.id),
    principalTeamIds:
      params.auth.authMethod === "oauth_user"
        ? await TeamModel.getUserTeamIds(params.auth.userId)
        : [],
  });

  const chatModels = sortRoutableModels(
    candidateModels.filter((model) => allowedModelIds.has(model.id)),
  );

  return {
    object: "list" as const,
    data: chatModels.map((model) => ({
      id: buildRoutableModelId(model),
      object: "model" as const,
      created: Math.floor(model.createdAt.getTime() / 1000),
      owned_by: model.provider,
    })),
  };
}

async function getModelRouterAgent(agentId: string | undefined) {
  const agent = await resolveAgent(agentId);
  if (agent.agentType !== "llm_proxy" && agent.agentType !== "agent") {
    throw new ApiError(400, "Model router requires an Agent or LLM Proxy ID.");
  }
  return agent;
}

async function getDefaultModelRouterAgent() {
  return getModelRouterAgent(undefined);
}

async function ensureModelRouterAgentAccess(params: {
  agent: GatewayAgent;
  auth: ModelRouterAuth;
}) {
  if (params.agent.organizationId !== params.auth.organizationId) {
    throw new ApiError(
      403,
      "Model Router virtual key cannot access this Agent.",
    );
  }
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
  const rawAuthHeader = request.raw.headers.authorization;
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
    ip: request.ip,
    credential: bearerToken,
  });
  try {
    const resolved = await validateVirtualApiKeyToken(bearerToken);
    const mappings = await VirtualApiKeyModel.getProviderApiKeysForRouting(
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
      virtualKeyScope: resolved.virtualKey.scope,
      virtualKeyAuthorId: resolved.virtualKey.authorId,
      providerApiKeysByProvider: new Map(
        mappings.map((mapping) => [mapping.provider, mapping]),
      ),
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) {
      try {
        await virtualKeyRateLimiter.recordFailure({
          ip: request.ip,
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

function getMappedProviders(auth: ModelRouterAuth): Set<SupportedProvider> {
  return new Set(auth.providerApiKeysByProvider.keys());
}

function getMappedApiKeyIds(auth: ModelRouterAuth): string[] {
  return [...auth.providerApiKeysByProvider.values()].map(
    (mapping) => mapping.providerApiKeyId,
  );
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

async function applyModelRouterAuthOverride(params: {
  request: FastifyRequest;
  auth: ModelRouterAuth;
  provider: SupportedProvider;
}): Promise<void> {
  const mappedApiKey = params.auth.providerApiKeysByProvider.get(
    params.provider,
  );
  if (!mappedApiKey) {
    throw new ApiError(
      400,
      `Model Router credential is not mapped to provider "${params.provider}".`,
    );
  }

  const apiKey = mappedApiKey.secretId
    ? await getSecretValueForLlmProviderApiKey(mappedApiKey.secretId)
    : undefined;
  assertSubscriptionCredentialForProvider({
    apiKey,
    provider: params.provider,
  });

  if (
    credentialRequiresPerUserScope({
      provider: params.provider,
      apiKey,
    })
  ) {
    const isOwnedPersonalCredential =
      mappedApiKey.scope === "personal" &&
      mappedApiKey.userId !== null &&
      (params.auth.authMethod === "oauth_user"
        ? mappedApiKey.userId === params.auth.userId
        : params.auth.authMethod === "virtual_key" &&
          params.auth.virtualKeyScope === "personal" &&
          params.auth.virtualKeyAuthorId !== null &&
          mappedApiKey.userId === params.auth.virtualKeyAuthorId);
    if (!isOwnedPersonalCredential) {
      throw new ApiError(
        403,
        `${perUserCredentialLabel({ provider: params.provider, apiKey })} is per-user: it can only be used through the same user's own personal credential.`,
      );
    }
  }
  (
    params.request as FastifyRequest & {
      llmProxyAuthOverride?: LLMProxyAuthOverride;
    }
  ).llmProxyAuthOverride = {
    apiKey,
    baseUrl: mappedApiKey.baseUrl ?? undefined,
    chatApiKeyId: mappedApiKey.providerApiKeyId,
    authenticated: true,
    source: "model_router",
    authMethod: params.auth.authMethod,
    authenticatedApp:
      params.auth.authMethod === "oauth_user"
        ? (params.auth.oauthClient ?? undefined)
        : params.auth.oauthClient,
    userId:
      params.auth.authMethod === "oauth_user" ? params.auth.userId : undefined,
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

  const providerApiKeys = await LlmProviderApiKeyModel.findByIds(
    oauthClient.providerApiKeys.map((mapping) => mapping.providerApiKeyId),
  );
  const providerApiKeysById = new Map(
    providerApiKeys.map((apiKey) => [apiKey.id, apiKey]),
  );

  return {
    authMethod: "oauth_client_credentials",
    organizationId: oauthClient.organizationId,
    oauthClient: {
      id: oauthClient.id,
      name: oauthClient.name,
      clientId: oauthClient.clientId,
    },
    providerApiKeysByProvider: new Map(
      oauthClient.providerApiKeys.map((mapping) => {
        const apiKey = providerApiKeysById.get(mapping.providerApiKeyId);
        if (!apiKey) {
          throw new ApiError(
            500,
            "LLM OAuth client references a missing provider API key.",
          );
        }
        return [
          mapping.provider,
          {
            provider: mapping.provider,
            providerApiKeyId: apiKey.id,
            providerApiKeyName: apiKey.name,
            secretId: apiKey.secretId,
            baseUrl: apiKey.inferenceBaseUrl ?? apiKey.baseUrl,
            scope: apiKey.scope,
            userId: apiKey.userId,
          },
        ];
      }),
    ),
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

  const userTeamIds = await TeamModel.getUserTeamIds(params.accessToken.userId);
  const providerApiKeys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
    member.organizationId,
    params.accessToken.userId,
    userTeamIds,
  );
  if (providerApiKeys.length === 0) {
    throw new ApiError(
      401,
      "OAuth user has no provider API keys available for Model Router usage.",
    );
  }

  const oauthClient = await OAuthClientModel.findByClientId(
    params.accessToken.clientId,
  );
  const providerApiKeysByProvider = new Map<
    SupportedProvider,
    ModelRouterMappedProviderKey
  >();
  for (const apiKey of [...providerApiKeys].sort(
    compareModelRouterUserProviderKeys,
  )) {
    if (providerApiKeysByProvider.has(apiKey.provider)) {
      continue;
    }
    providerApiKeysByProvider.set(apiKey.provider, {
      provider: apiKey.provider,
      providerApiKeyId: apiKey.id,
      providerApiKeyName: apiKey.name,
      secretId: apiKey.secretId,
      baseUrl: apiKey.inferenceBaseUrl ?? apiKey.baseUrl,
      scope: apiKey.scope,
      userId: apiKey.userId,
    });
  }

  return {
    authMethod: "oauth_user",
    organizationId: member.organizationId,
    userId: params.accessToken.userId,
    providerApiKeysByProvider,
    oauthClient: oauthClient
      ? {
          id: oauthClient.id,
          name: oauthClient.name ?? oauthClient.clientId,
          clientId: oauthClient.clientId,
        }
      : null,
  };
}

function compareModelRouterUserProviderKeys(
  left: ModelRouterUserProviderKey,
  right: ModelRouterUserProviderKey,
) {
  if (left.provider !== right.provider) {
    return left.provider.localeCompare(right.provider);
  }

  const leftScopePriority = getModelRouterUserProviderKeyScopePriority(left);
  const rightScopePriority = getModelRouterUserProviderKeyScopePriority(right);
  if (leftScopePriority !== rightScopePriority) {
    return leftScopePriority - rightScopePriority;
  }

  if (left.isPrimary !== right.isPrimary) {
    return left.isPrimary ? -1 : 1;
  }

  return left.createdAt.getTime() - right.createdAt.getTime();
}

function getModelRouterUserProviderKeyScopePriority(
  apiKey: ModelRouterUserProviderKey,
) {
  switch (apiKey.scope) {
    case "personal":
      return 0;
    case "team":
      return 1;
    case "org":
      return 2;
    default:
      return 3;
  }
}

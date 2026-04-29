import {
  hasArchestraTokenPrefix,
  RouteId,
  type SupportedProvider,
} from "@shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { AgentModel, ModelModel, VirtualApiKeyModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import type { LLMProvider } from "@/types";
import {
  ApiError,
  Azure,
  constructResponseSchema,
  OpenAi,
  UuidIdSchema,
} from "@/types";
import {
  azureAdapterFactory,
  cerebrasAdapterFactory,
  deepseekAdapterFactory,
  groqAdapterFactory,
  minimaxAdapterFactory,
  mistralAdapterFactory,
  ollamaAdapterFactory,
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
import { responsesToOpenaiChat } from "../adapters/openai-responses-translator";
import { MODEL_ROUTER_PREFIX, PROXY_BODY_LIMIT } from "../common";
import {
  validateVirtualApiKeyToken,
  virtualKeyRateLimiter,
} from "../llm-proxy-auth";
import {
  handleLLMProxy,
  type LLMProxyAuthOverride,
} from "../llm-proxy-handler";
import {
  buildRoutableModelId,
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

type ModelRouterMappedProviderKey = {
  provider: SupportedProvider;
  chatApiKeyId: string;
  chatApiKeyName: string;
  secretId: string | null;
  baseUrl: string | null;
};

type ModelRouterVirtualKeyAuth = {
  providerApiKeysByProvider: Map<
    SupportedProvider,
    ModelRouterMappedProviderKey
  >;
};

const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const RESPONSES_SUFFIX = "/responses";

const openAiWireProviders: Partial<
  Record<SupportedProvider, OpenAiWireProvider>
> = {
  openai: openaiAdapterFactory as OpenAiWireProvider,
  azure: azureAdapterFactory as OpenAiWireProvider,
  cerebras: cerebrasAdapterFactory as OpenAiWireProvider,
  deepseek: deepseekAdapterFactory as OpenAiWireProvider,
  groq: groqAdapterFactory as OpenAiWireProvider,
  minimax: minimaxAdapterFactory as OpenAiWireProvider,
  mistral: mistralAdapterFactory as OpenAiWireProvider,
  ollama: ollamaAdapterFactory as OpenAiWireProvider,
  openrouter: openrouterAdapterFactory as OpenAiWireProvider,
  perplexity: perplexityAdapterFactory as OpenAiWireProvider,
  vllm: vllmAdapterFactory as OpenAiWireProvider,
  xai: xaiAdapterFactory as OpenAiWireProvider,
  zhipuai: zhipuaiAdapterFactory as OpenAiWireProvider,
};

const modelRouterSupportedProviders = new Set<SupportedProvider>([
  ...(Object.keys(openAiWireProviders) as SupportedProvider[]),
  "anthropic",
  "bedrock",
  "cohere",
  "gemini",
]);

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
      const auth = await getModelRouterVirtualKeyAuth(request);
      await AgentModel.getDefaultProfile();
      return reply.send(
        await listModels({
          providers: getMappedProviders(auth),
        }),
      );
    },
  );

  fastify.get(
    `${MODEL_ROUTER_PREFIX}/:agentId/models`,
    {
      schema: {
        operationId: RouteId.ModelRouterListModelsWithAgent,
        description:
          "List OpenAI-compatible model ids available through the model router (specific LLM proxy)",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        response: constructResponseSchema(ModelListResponseSchema),
      },
    },
    async (request, reply) => {
      const auth = await getModelRouterVirtualKeyAuth(request);
      await getModelRouterAgent(request.params.agentId);
      return reply.send(
        await listModels({
          providers: getMappedProviders(auth),
        }),
      );
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
        body: Azure.API.ResponsesRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(Azure.API.ResponsesResponseSchema),
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
          "Create a response through the OpenAI-compatible model router (specific LLM proxy)",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Azure.API.ResponsesRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(Azure.API.ResponsesResponseSchema),
      },
    },
    async (request, reply) => {
      return routeResponse(request, reply);
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
          "Create a chat completion through the OpenAI-compatible model router (specific LLM proxy)",
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
  if (params.agentId) {
    await getModelRouterAgent(params.agentId);
  } else {
    await AgentModel.getDefaultProfile();
  }
  const auth = await getModelRouterVirtualKeyAuth(request);
  const resolution = await resolveModelRoute({
    requestedModel: body.model,
    allowedProviders: getMappedProviders(auth),
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

  const provider = getOpenAiChatProviderForResolution({
    provider: resolution.provider,
    body: routedBody,
  });
  await applyModelRouterAuthOverride({
    request,
    auth,
    provider: resolution.provider,
  });

  return handleLLMProxy(provider.body, request, reply, provider.adapter);
}

async function routeResponse(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as Azure.Types.ResponsesRequest;
  const { chatBody, responsesContext } = responsesToOpenaiChat(body);
  const params = request.params as { agentId?: string };
  if (params.agentId) {
    await getModelRouterAgent(params.agentId);
  } else {
    await AgentModel.getDefaultProfile();
  }
  const auth = await getModelRouterVirtualKeyAuth(request);
  const resolution = await resolveModelRoute({
    requestedModel: chatBody.model,
    allowedProviders: getMappedProviders(auth),
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
    provider: resolution.provider,
  });

  return handleLLMProxy(
    provider.body,
    request,
    reply,
    makeResponsesFromChatAdapterFactory(
      provider.adapter as OpenAiWireProvider,
      responsesContext,
    ),
  );
}

function getOpenAiChatProviderForResolution(params: {
  provider: SupportedProvider;
  body: OpenAi.Types.ChatCompletionsRequest;
}): {
  body: OpenAi.Types.ChatCompletionsRequest;
  adapter: OpenAiWireProvider;
} {
  const provider = openAiWireProviders[params.provider];
  if (provider) {
    return { body: params.body, adapter: provider };
  }

  if (params.provider === "anthropic") {
    const { anthropicBody, openaiContext } = openaiToAnthropic(params.body);
    return {
      body: anthropicBody as unknown as OpenAi.Types.ChatCompletionsRequest,
      adapter: makeAnthropicOpenaiAdapterFactory(
        openaiContext,
      ) as unknown as OpenAiWireProvider,
    };
  }

  if (params.provider === "bedrock") {
    const { converseBody, openaiContext } = openaiToConverse(params.body);
    return {
      body: converseBody as unknown as OpenAi.Types.ChatCompletionsRequest,
      adapter: makeBedrockOpenaiAdapterFactory(
        openaiContext,
      ) as unknown as OpenAiWireProvider,
    };
  }

  if (params.provider === "cohere") {
    const { cohereBody, openaiContext } = openaiToCohere(params.body);
    return {
      body: cohereBody as unknown as OpenAi.Types.ChatCompletionsRequest,
      adapter: makeCohereOpenaiAdapterFactory(
        openaiContext,
      ) as unknown as OpenAiWireProvider,
    };
  }

  if (params.provider === "gemini") {
    const { geminiBody, openaiContext } = openaiToGemini(params.body);
    return {
      body: geminiBody as unknown as OpenAi.Types.ChatCompletionsRequest,
      adapter: makeGeminiOpenaiAdapterFactory(
        openaiContext,
      ) as unknown as OpenAiWireProvider,
    };
  }

  throw new ApiError(
    501,
    `Provider "${params.provider}" is not yet available through the OpenAI-compatible model router.`,
  );
}

async function listModels(params: { providers: Set<SupportedProvider> }) {
  const allModels = await ModelModel.findAll({});
  const chatModels = sortRoutableModels(
    allModels.filter((model) => {
      if (!params.providers.has(model.provider)) {
        return false;
      }
      if (!ModelModel.supportsTextChat(model)) {
        return false;
      }
      if (!modelRouterSupportedProviders.has(model.provider)) {
        return false;
      }
      return true;
    }),
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

async function getModelRouterAgent(agentId: string) {
  const agent = await AgentModel.findById(agentId, undefined, true);
  if (!agent) {
    throw new ApiError(404, `Agent with ID ${agentId} not found`);
  }
  if (agent.agentType !== "llm_proxy") {
    throw new ApiError(400, "Model router requires an LLM Proxy ID.");
  }
  return agent;
}

async function getModelRouterVirtualKeyAuth(
  request: FastifyRequest,
): Promise<ModelRouterVirtualKeyAuth> {
  const rawAuthHeader = request.raw.headers.authorization;
  const tokenMatch = rawAuthHeader?.match(/^Bearer\s+(.+)$/i);
  const bearerToken = tokenMatch?.[1];
  if (!bearerToken || !hasArchestraTokenPrefix(bearerToken)) {
    throw new ApiError(
      401,
      "Model router requests require a Model Router-enabled virtual API key.",
    );
  }

  await virtualKeyRateLimiter.check(request.ip);
  try {
    const resolved = await validateVirtualApiKeyToken(bearerToken);
    if (!resolved.virtualKey.modelRouterEnabled) {
      throw new ApiError(
        401,
        "Model router requests require a Model Router-enabled virtual API key.",
      );
    }

    const mappings =
      await VirtualApiKeyModel.getModelRouterProviderApiKeysForRouting(
        resolved.virtualKey.id,
      );
    if (mappings.length === 0) {
      throw new ApiError(
        401,
        "Model Router virtual key has no provider API keys configured.",
      );
    }

    return {
      providerApiKeysByProvider: new Map(
        mappings.map((mapping) => [mapping.provider, mapping]),
      ),
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) {
      try {
        await virtualKeyRateLimiter.recordFailure(request.ip);
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

function getMappedProviders(
  auth: ModelRouterVirtualKeyAuth,
): Set<SupportedProvider> {
  return new Set(auth.providerApiKeysByProvider.keys());
}

async function applyModelRouterAuthOverride(params: {
  request: FastifyRequest;
  auth: ModelRouterVirtualKeyAuth;
  provider: SupportedProvider;
}): Promise<void> {
  const mappedApiKey = params.auth.providerApiKeysByProvider.get(
    params.provider,
  );
  if (!mappedApiKey) {
    throw new ApiError(
      400,
      `Model Router virtual key is not mapped to provider "${params.provider}".`,
    );
  }

  const apiKey = mappedApiKey.secretId
    ? ((await getSecretValueForLlmProviderApiKey(mappedApiKey.secretId)) as
        | string
        | undefined)
    : undefined;
  (
    params.request as FastifyRequest & {
      llmProxyAuthOverride?: LLMProxyAuthOverride;
    }
  ).llmProxyAuthOverride = {
    apiKey,
    baseUrl: mappedApiKey.baseUrl ?? undefined,
    authenticated: true,
  };
}

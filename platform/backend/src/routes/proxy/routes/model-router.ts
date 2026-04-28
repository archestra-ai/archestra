import {
  hasArchestraTokenPrefix,
  RouteId,
  type SupportedProvider,
} from "@shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { AgentModel, ModelModel } from "@/models";
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
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import {
  validateVirtualApiKey,
  virtualKeyRateLimiter,
} from "../llm-proxy-auth";
import { handleLLMProxy } from "../llm-proxy-handler";
import {
  buildRoutableModelId,
  resolveModelRoute,
  sortRoutableModels,
} from "../model-router/resolver";

type OpenAiWireProvider = LLMProvider<
  OpenAi.Types.ChatCompletionsRequest,
  unknown,
  unknown,
  unknown,
  OpenAi.Types.ChatCompletionsHeaders
>;

const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const RESPONSES_SUFFIX = "/responses";
const MODEL_ROUTER_PREFIX = `${PROXY_API_PREFIX}/model-router`;

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
      const allowedProvider = await getVirtualKeyProviderScope(request);
      const agent = await AgentModel.getDefaultProfile();
      return reply.send(
        await listModels({
          allowedProvider,
          allowedModelIds: agent?.modelRouterAllowedModelIds,
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
      const allowedProvider = await getVirtualKeyProviderScope(request);
      const agent = await getModelRouterAgent(request.params.agentId);
      return reply.send(
        await listModels({
          allowedProvider,
          allowedModelIds: agent.modelRouterAllowedModelIds,
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
  const agent = params.agentId
    ? await getModelRouterAgent(params.agentId)
    : await AgentModel.getDefaultProfile();
  const allowedProvider = await getVirtualKeyProviderScope(request);
  const resolution = await resolveModelRoute({
    requestedModel: body.model,
    allowedProvider,
    allowedModelIds: agent?.modelRouterAllowedModelIds,
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

  return handleLLMProxy(provider.body, request, reply, provider.adapter);
}

async function routeResponse(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as Azure.Types.ResponsesRequest;
  if (body.stream === true) {
    throw new ApiError(
      501,
      "Streaming is not yet available through the model router Responses API.",
    );
  }

  const { chatBody, responsesContext } = responsesToOpenaiChat(body);
  const params = request.params as { agentId?: string };
  const agent = params.agentId
    ? await getModelRouterAgent(params.agentId)
    : await AgentModel.getDefaultProfile();
  const allowedProvider = await getVirtualKeyProviderScope(request);
  const resolution = await resolveModelRoute({
    requestedModel: chatBody.model,
    allowedProvider,
    allowedModelIds: agent?.modelRouterAllowedModelIds,
  });
  const routedChatBody = {
    ...chatBody,
    model: resolution.modelId,
  };

  const provider = getOpenAiChatProviderForResolution({
    provider: resolution.provider,
    body: routedChatBody,
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

async function listModels(params: {
  allowedProvider: SupportedProvider | undefined;
  allowedModelIds: string[] | null | undefined;
}) {
  const allModels = await ModelModel.findAll({
    provider: params.allowedProvider,
  });
  const allowedSet =
    params.allowedModelIds == null ? null : new Set(params.allowedModelIds);
  const chatModels = sortRoutableModels(
    allModels.filter((model) => {
      if (!ModelModel.supportsTextChat(model)) {
        return false;
      }
      if (!modelRouterSupportedProviders.has(model.provider)) {
        return false;
      }
      if (!allowedSet) {
        return true;
      }
      return allowedSet.has(buildRoutableModelId(model));
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

async function getVirtualKeyProviderScope(
  request: FastifyRequest,
): Promise<SupportedProvider | undefined> {
  const rawAuthHeader = request.raw.headers.authorization;
  const tokenMatch = rawAuthHeader?.match(/^Bearer\s+(.+)$/i);
  const bearerToken = tokenMatch?.[1];
  if (!bearerToken || !hasArchestraTokenPrefix(bearerToken)) {
    return undefined;
  }

  await virtualKeyRateLimiter.check(request.ip);
  try {
    const provider = await inferProviderForVirtualKey(bearerToken);
    await validateVirtualApiKey(bearerToken, provider);
    return provider;
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) {
      await virtualKeyRateLimiter.recordFailure(request.ip);
    }
    throw error;
  }
}

async function inferProviderForVirtualKey(
  tokenValue: string,
): Promise<SupportedProvider> {
  // Load lazily to keep this proxy route independent from model index cycles.
  const { VirtualApiKeyModel } = await import("@/models");
  const resolved = await VirtualApiKeyModel.validateToken(tokenValue);
  if (!resolved) {
    throw new ApiError(401, "Invalid virtual API key");
  }
  return resolved.chatApiKey.provider;
}

/**
 * Unified LLM Gateway Proxy Routes
 *
 * Routes requests to the appropriate provider adapter based on the model name.
 */
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { ModelModel } from "@/models";
import {
  ApiError,
  Azure,
  constructResponseSchema,
  type LLMProvider,
  OpenAi,
  UuidIdSchema,
} from "@/types";
import {
  anthropicAdapterFactory,
  azureAdapterFactory,
  bedrockAdapterFactory,
  cerebrasAdapterFactory,
  cohereAdapterFactory,
  deepseekAdapterFactory,
  geminiAdapterFactory,
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
import { buildUnifiedResponsesAdapter } from "../adapters/unified-responses";
import {
  buildUnifiedAnthropicProvider,
  buildUnifiedBedrockProvider,
  buildUnifiedCohereProvider,
  buildUnifiedGeminiProvider,
} from "../adapters/unified-translation";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";

type OAIRequest = OpenAi.Types.ChatCompletionsRequest;
type OAIResponse = OpenAi.Types.ChatCompletionsResponse;
type OAIAdapter = LLMProvider<
  OAIRequest,
  OAIResponse,
  unknown[],
  unknown,
  unknown
>;

function asOAIAdapter(factory: unknown): OAIAdapter {
  return factory as OAIAdapter;
}

const openAiCompatibleAdapters: Record<string, OAIAdapter> = {
  azure: asOAIAdapter(azureAdapterFactory),
  cerebras: asOAIAdapter(cerebrasAdapterFactory),
  deepseek: asOAIAdapter(deepseekAdapterFactory),
  groq: asOAIAdapter(groqAdapterFactory),
  minimax: asOAIAdapter(minimaxAdapterFactory),
  mistral: asOAIAdapter(mistralAdapterFactory),
  ollama: asOAIAdapter(ollamaAdapterFactory),
  openai: asOAIAdapter(openaiAdapterFactory),
  openrouter: asOAIAdapter(openrouterAdapterFactory),
  perplexity: asOAIAdapter(perplexityAdapterFactory),
  vllm: asOAIAdapter(vllmAdapterFactory),
  xai: asOAIAdapter(xaiAdapterFactory),
  zhipuai: asOAIAdapter(zhipuaiAdapterFactory),
};

const translationAdapters: Record<string, OAIAdapter> = {
  anthropic: buildUnifiedAnthropicProvider(
    anthropicAdapterFactory as unknown as LLMProvider<
      unknown,
      unknown,
      unknown,
      unknown,
      unknown
    >,
  ) as unknown as OAIAdapter,
  gemini: buildUnifiedGeminiProvider(
    geminiAdapterFactory as unknown as LLMProvider<
      unknown,
      unknown,
      unknown,
      unknown,
      unknown
    >,
  ) as unknown as OAIAdapter,
  cohere: buildUnifiedCohereProvider(
    cohereAdapterFactory as unknown as LLMProvider<
      unknown,
      unknown,
      unknown,
      unknown,
      unknown
    >,
  ) as unknown as OAIAdapter,
  bedrock: buildUnifiedBedrockProvider(
    bedrockAdapterFactory as unknown as LLMProvider<
      unknown,
      unknown,
      unknown,
      unknown,
      unknown
    >,
  ) as unknown as OAIAdapter,
};

async function resolveProviderAdapter(model: string): Promise<OAIAdapter> {
  const modelRecord = await ModelModel.findByModelIdOnly(model);
  if (!modelRecord) {
    throw new ApiError(404, `Model "${model}" not found in the model registry`);
  }

  const oaiAdapter = openAiCompatibleAdapters[modelRecord.provider];
  if (oaiAdapter) {
    return oaiAdapter;
  }

  const translationAdapter = translationAdapters[modelRecord.provider];
  if (translationAdapter) {
    return translationAdapter;
  }

  throw new ApiError(
    400,
    `Provider "${modelRecord.provider}" is not supported by the unified endpoint`,
  );
}

const unifiedProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/unified`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
  const RESPONSES_SUFFIX = "/responses";

  logger.info("[UnifiedProxy] Registering unified gateway routes");

  fastify.get(
    `${API_PREFIX}/models`,
    {
      schema: {
        operationId: RouteId.UnifiedListModels,
        description:
          "List all available models across all providers in OpenAI format",
        tags: ["LLM Proxy"],
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: {
          200: z.object({
            object: z.literal("list"),
            data: z.array(
              z.object({
                id: z.string(),
                object: z.literal("model"),
                created: z.number(),
                owned_by: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (_request, _reply) => {
      const models = await ModelModel.findAll();
      return {
        object: "list" as const,
        data: models.map((m) => ({
          id: m.modelId,
          object: "model" as const,
          created: Math.floor(
            new Date(m.lastSyncedAt ?? Date.now()).getTime() / 1000,
          ),
          owned_by: m.provider,
        })),
      };
    },
  );

  fastify.get(
    `${API_PREFIX}/:agentId/models`,
    {
      schema: {
        operationId: RouteId.UnifiedListModelsWithAgent,
        description:
          "List all available models (agent-scoped URL for OpenAI client compatibility)",
        tags: ["LLM Proxy"],
        params: z.object({ agentId: UuidIdSchema }),
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: {
          200: z.object({
            object: z.literal("list"),
            data: z.array(
              z.object({
                id: z.string(),
                object: z.literal("model"),
                created: z.number(),
                owned_by: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (_request, _reply) => {
      const models = await ModelModel.findAll();
      return {
        object: "list" as const,
        data: models.map((m) => ({
          id: m.modelId,
          object: "model" as const,
          created: Math.floor(
            new Date(m.lastSyncedAt ?? Date.now()).getTime() / 1000,
          ),
          owned_by: m.provider,
        })),
      };
    },
  );

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.UnifiedChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion via the unified gateway (uses default agent)",
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
        "[UnifiedProxy] Handling unified request (default agent)",
      );
      const adapter = await resolveProviderAdapter(request.body.model);
      return handleLLMProxy(request.body, request, reply, adapter);
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.UnifiedChatCompletionsWithAgent,
        description:
          "Create a chat completion via the unified gateway for a specific agent",
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
        "[UnifiedProxy] Handling unified request (with agent)",
      );
      const adapter = await resolveProviderAdapter(request.body.model);
      return handleLLMProxy(request.body, request, reply, adapter);
    },
  );

  fastify.post(
    `${API_PREFIX}${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.UnifiedResponsesWithDefaultAgent,
        description:
          "Create a response via the unified gateway (uses default agent)",
        tags: ["LLM Proxy"],
        body: Azure.API.ResponsesRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(Azure.API.ResponsesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling unified responses request (default agent)",
      );
      const innerAdapter = await resolveProviderAdapter(request.body.model);
      const responsesAdapter = buildUnifiedResponsesAdapter(innerAdapter);
      return handleLLMProxy(
        request.body as Azure.Types.ResponsesRequest,
        request,
        reply,
        responsesAdapter,
      );
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.UnifiedResponsesWithAgent,
        description:
          "Create a response via the unified gateway for a specific agent",
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
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling unified responses request (with agent)",
      );
      const innerAdapter = await resolveProviderAdapter(request.body.model);
      const responsesAdapter = buildUnifiedResponsesAdapter(innerAdapter);
      return handleLLMProxy(
        request.body as Azure.Types.ResponsesRequest,
        request,
        reply,
        responsesAdapter,
      );
    },
  );
};

export default unifiedProxyRoutes;

import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { detectProviderFromModel } from "@/clients/llm-client";
import logger from "@/logging";
import { ModelModel, LlmProviderApiKeyModelLinkModel } from "@/models";
import { constructResponseSchema, OpenAi, UuidIdSchema } from "@/types";
import config from "@/config";
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
import { makeBedrockOpenaiAdapterFactory } from "../adapters/bedrock-openai";
import { openaiToConverse } from "../adapters/bedrock-openai-translator";
import { makeAnthropicOpenaiAdapterFactory, openaiToAnthropic } from "../adapters/anthropic-openai";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";

const adapterFactories: Record<string, any> = {
  openai: openaiAdapterFactory,
  anthropic: anthropicAdapterFactory,
  gemini: geminiAdapterFactory,
  bedrock: bedrockAdapterFactory,
  cohere: cohereAdapterFactory,
  cerebras: cerebrasAdapterFactory,
  mistral: mistralAdapterFactory,
  perplexity: perplexityAdapterFactory,
  groq: groqAdapterFactory,
  xai: xaiAdapterFactory,
  openrouter: openrouterAdapterFactory,
  vllm: vllmAdapterFactory,
  ollama: ollamaAdapterFactory,
  zhipuai: zhipuaiAdapterFactory,
  deepseek: deepseekAdapterFactory,
  minimax: minimaxAdapterFactory,
  azure: azureAdapterFactory,
};

const unifiedProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/unified`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  fastify.get(
    `${API_PREFIX}/models`,
    {
      schema: {
        operationId: RouteId.UnifiedModels,
        description: "List all available models from all providers",
        tags: ["LLM Proxy"],
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
      const modelsWithKeys = await LlmProviderApiKeyModelLinkModel.getAllModelsWithApiKeys();
      const createdUnix = Math.floor(Date.now() / 1000);

      return {
        object: "list",
        data: modelsWithKeys.map(({ model }) => ({
          id: model.modelId,
          object: "model",
          created: model.createdAt ? Math.floor(model.createdAt.getTime() / 1000) : createdUnix,
          owned_by: model.provider,
        })),
      };
    },
  );

  const handleUnifiedChatCompletions = async (request: any, reply: any) => {
    const body = request.body as any;
    const modelId = body.model;

    if (!modelId) {
      return reply.status(400).send({
        error: {
          message: "Model is required",
          type: "invalid_request_error",
        },
      });
    }

    // Try to find provider for this model
    const model = await ModelModel.findByModelIdOnly(modelId);
    let providerName: string | undefined = model?.provider;

    // Fallback heuristics if not found in DB
    if (!providerName) {
      providerName = detectProviderFromModel(modelId);
      
      // Additional heuristics for common providers not in detectProviderFromModel
      if (providerName === "anthropic" && !modelId.toLowerCase().includes("claude")) {
          const lowerModelId = modelId.toLowerCase();
          if (lowerModelId.includes("mistral") || lowerModelId.includes("mixtral")) {
              providerName = "mistral";
          } else if (lowerModelId.includes("llama")) {
              providerName = "groq";
          }
      }
    }

    if (!providerName || !adapterFactories[providerName]) {
      providerName = "openai";
    }

    logger.info(
      { modelId, providerName },
      "[UnifiedProxy] Auto-routing request to provider",
    );

    // Special handling for providers that need translation from OpenAI format
    if (providerName === "bedrock") {
      const { converseBody, openaiContext } = openaiToConverse(request.body);
      return handleLLMProxy(
        converseBody,
        request,
        reply,
        makeBedrockOpenaiAdapterFactory(openaiContext),
      );
    }

    if (providerName === "anthropic") {
      const { anthropicBody, context } = openaiToAnthropic(request.body);
      return handleLLMProxy(
        anthropicBody,
        request,
        reply,
        makeAnthropicOpenaiAdapterFactory(context),
      );
    }

    // For Gemini, we can use their OpenAI-compatible endpoint
    if (providerName === "gemini") {
      return handleLLMProxy(request.body, request, reply, {
        ...openaiAdapterFactory,
        provider: "gemini",
        getBaseUrl: () => "https://generativelanguage.googleapis.com/v1beta/openai",
      });
    }

    // For Cohere, we use their V2 OpenAI-compatible endpoint
    if (providerName === "cohere") {
      return handleLLMProxy(request.body, request, reply, {
        ...openaiAdapterFactory,
        provider: "cohere",
        getBaseUrl: () => `${config.llm.cohere.baseUrl}/v2`,
      });
    }

    const adapterFactory = adapterFactories[providerName];
    return handleLLMProxy(request.body, request, reply, adapterFactory);
  };

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.UnifiedChatCompletionsWithDefaultAgent,
        description:
          "Create a chat completion (auto-routes to correct provider)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(
          OpenAi.API.ChatCompletionResponseSchema,
        ),
      },
    },
    handleUnifiedChatCompletions,
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.UnifiedChatCompletionsWithAgent,
        description:
          "Create a chat completion for a specific agent (auto-routes)",
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
    handleUnifiedChatCompletions,
  );
};

export default unifiedProxyRoutes;

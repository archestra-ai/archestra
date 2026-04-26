import { RouteId, type SupportedProvider } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { ModelModel } from "@/models";
import { constructResponseSchema, OpenAi, UuidIdSchema } from "@/types";
import * as adapters from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";

const unifiedProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/unified`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  const adapterMap: Partial<Record<SupportedProvider, any>> = {
    openai: adapters.openaiAdapterFactory,
    groq: adapters.groqAdapterFactory,
    mistral: adapters.mistralAdapterFactory,
    deepseek: adapters.deepseekAdapterFactory,
    perplexity: adapters.perplexityAdapterFactory,
    cerebras: adapters.cerebrasAdapterFactory,
    ollama: adapters.ollamaAdapterFactory,
    vllm: adapters.vllmAdapterFactory,
    xai: adapters.xaiAdapterFactory,
    openrouter: adapters.openrouterAdapterFactory,
    zhipuai: adapters.zhipuaiAdapterFactory,
    minimax: adapters.minimaxAdapterFactory,
  };

  const handleUnified = async (request: any, reply: any) => {
    const { model } = request.body;
    
    // Determine provider from database
    const modelRecord = await ModelModel.findByModelIdOnly(model);
    let provider = modelRecord?.provider as string | undefined;

    // Heuristics for unknown models
    if (!provider) {
      if (model.startsWith("gpt-") || model.startsWith("o1-")) provider = "openai";
      else if (model.startsWith("claude-")) provider = "anthropic";
      else if (model.startsWith("gemini-")) provider = "gemini";
    }

    provider = provider || "openai";

    logger.info({ model, provider }, "[UnifiedProxy] Routing request");

    const factory = adapterMap[provider as SupportedProvider] || adapters.openaiAdapterFactory;
    
    // Note: Translation logic for Anthropic/Gemini to be added in next iteration
    // For now, routing to OpenAI-compatible providers.
    return handleLLMProxy(request.body as any, request, reply, factory);
  };

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiChatCompletionsWithDefaultAgent,
        description: "Unified OpenAI-format endpoint (default agent)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.ChatCompletionResponseSchema),
      },
    },
    handleUnified
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.OpenAiChatCompletionsWithAgent,
        description: "Unified OpenAI-format endpoint (specific agent)",
        tags: ["LLM Proxy"],
        params: z.object({ agentId: UuidIdSchema }),
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.ChatCompletionResponseSchema),
      },
    },
    handleUnified
  );
};

export default unifiedProxyRoutes;

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { detectProviderFromModel } from "@/clients/llm-client";
import logger from "@/logging";
import { LlmProviderApiKeyModelLinkModel } from "@/models";
import { OpenAi, constructResponseSchema, UuidIdSchema } from "@/types";
import { anthropicAdapterFactory } from "../adapters/anthropic";
import { openaiAdapterFactory } from "../adapters/openai";
import { geminiAdapterFactory } from "../adapters/gemini";
import { cohereAdapterFactory } from "../adapters/cohere";
import { cerebrasAdapterFactory } from "../adapters/cerebras";
import { deepseekAdapterFactory } from "../adapters/deepseek";
import { groqAdapterFactory } from "../adapters/groq";
import { minimaxAdapterFactory } from "../adapters/minimax";
import { mistralAdapterFactory } from "../adapters/mistral";
import { ollamaAdapterFactory } from "../adapters/ollama";
import { openrouterAdapterFactory } from "../adapters/openrouter";
import { perplexityAdapterFactory } from "../adapters/perplexity";
import { vllmAdapterFactory } from "../adapters/vllm";
import { xaiAdapterFactory } from "../adapters/xai";
import { zhipuaiAdapterFactory } from "../adapters/zhipuai";
import { bedrockAdapterFactory } from "../adapters/bedrock";
import { bedrockOpenaiAdapterFactory } from "../adapters/bedrock-openai";
import { azureAdapterFactory } from "../adapters/azure";
import type { LLMProvider } from "@/types/llm-provider";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { handleLLMProxy } from "../llm-proxy-handler";

// Map each provider to its adapter factory
const ADAPTER_FACTORIES: Record<string, ReturnType<typeof openaiAdapterFactory>> = {
  openai: openaiAdapterFactory,
  anthropic: anthropicAdapterFactory,
  gemini: geminiAdapterFactory,
  cohere: cohereAdapterFactory,
  cerebras: cerebrasAdapterFactory,
  deepseek: deepseekAdapterFactory,
  groq: groqAdapterFactory,
  minimax: minimaxAdapterFactory,
  mistral: mistralAdapterFactory,
  ollama: ollamaAdapterFactory,
  openrouter: openrouterAdapterFactory,
  perplexity: perplexityAdapterFactory,
  vllm: vllmAdapterFactory,
  xai: xaiAdapterFactory,
  zhipuai: zhipuaiAdapterFactory,
  bedrock: bedrockAdapterFactory,
  bedrockOpenai: bedrockOpenaiAdapterFactory,
  azure: azureAdapterFactory,
};

/**
 * Given a model name, find which provider has it configured in the DB.
 * Returns the provider name or null if not found.
 */
async function findProviderForModel(model: string): Promise<string | null> {
  for (const provider of Object.keys(ADAPTER_FACTORIES)) {
    const linked = await LlmProviderApiKeyModelLinkModel.findByModel(model, provider);
    if (linked) {
      return provider;
    }
  }
  return null;
}

const unifiedProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/unified`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info("[UnifiedProxy] Registering unified LLM proxy routes");

  /**
   * Unified chat completions endpoint.
   * Accepts OpenAI-format requests and routes to the appropriate provider
   * based on the model parameter.
   *
   * Routes:
   *   POST /v1/unified/chat/completions           – default agent
   *   POST /v1/unified/:agentId/chat/completions – specific agent
   */
  async function handleUnifiedChat(
    request: typeof fastify.request,
    reply: typeof fastify.reply,
    agentId?: string,
  ) {
    const body = request.body as OpenAi.Types.ChatCompletionsRequest;
    const model: string = body.model;

    // Step 1: Try to find the provider from the DB (most accurate – user configured it)
    let providerName = await findProviderForModel(model);

    // Step 2: Fall back to auto-detection from model name
    if (!providerName) {
      providerName = detectProviderFromModel(model);
      logger.debug(
        { model, detectedProvider: providerName },
        "[UnifiedProxy] DB lookup missed, using model-name detection",
      );
    }

    // Step 3: Validate we have an adapter for this provider
    const adapterFactory = ADAPTER_FACTORIES[providerName];
    if (!adapterFactory) {
      logger.warn({ provider: providerName }, "[UnifiedProxy] No adapter factory for provider");
      reply.code(400).send({
        error: {
          message: `Unsupported model: '${model}'. Could not route to any provider.`,
          type: "invalid_request_error",
        },
      });
      return;
    }

    logger.info(
      { model, provider: providerName, agentId: agentId ?? "default" },
      "[UnifiedProxy] Routing request to provider",
    );

    return handleLLMProxy(
      body,
      request,
      reply,
      adapterFactory as LLMProvider<unknown, unknown, unknown, unknown, unknown>,
    );
  }

  // Default agent variant
  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        description:
          "Unified LLM proxy – routes OpenAI-format requests to any configured provider",
        tags: ["LLM Proxy"],
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.ChatCompletionResponseSchema),
      },
    },
    async (request, reply) => {
      return handleUnifiedChat(request, reply);
    },
  );

  // Explicit agent variant
  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        description: "Unified LLM proxy for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({ agentId: UuidIdSchema }),
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: OpenAi.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(OpenAi.API.ChatCompletionResponseSchema),
      },
    },
    async (request, reply) => {
      return handleUnifiedChat(request, reply, request.params.agentId);
    },
  );
};

export default unifiedProxyRoutes;

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { constructResponseSchema, Gemini, OpenAI } from "@/types";
import * as adapters from "../adapters";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { validateVirtualApiKey } from "../llm-proxy-auth";
import { handleLLMProxy } from "../llm-proxy-handler";

/**
 * Registry mapping provider names to their respective adapter factories.
 */
const providerRegistry: Record<string, any> = {
  openai: adapters.openaiAdapterFactory,
  anthropic: adapters.anthropicAdapterFactory,
  gemini: adapters.geminiAdapterFactory,
  azure: adapters.azureAdapterFactory,
  "azure-responses": adapters.azureResponsesAdapterFactory,
  bedrock: adapters.bedrockAdapterFactory,
  cerebras: adapters.cerebrasAdapterFactory,
  cohere: adapters.cohereAdapterFactory,
  deepseek: adapters.deepseekAdapterFactory,
  groq: adapters.groqAdapterFactory,
  minimax: adapters.minimaxAdapterFactory,
  mistral: adapters.mistralAdapterFactory,
  ollama: adapters.ollamaAdapterFactory,
  openrouter: adapters.openrouterAdapterFactory,
  perplexity: adapters.perplexityAdapterFactory,
  vllm: adapters.vllmAdapterFactory,
  xai: adapters.xaiAdapterFactory,
  zhipuai: adapters.zhipuaiAdapterFactory,
};

const unifiedProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/v1`;

  logger.info("[UnifiedProxy] Registering unified OpenAI-compatible routes");

  /**
   * Unified Chat Completions endpoint (OpenAI compatible)
   * Handled by determining the provider from the virtual API key.
   */
  fastify.post(
    "/chat/completions",
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        description: "Unified OpenAI-compatible chat completions",
        summary: "Chat completions via provider-agnostic endpoint",
        tags: ["LLM Proxy"],
        headers: OpenAI.API.ChatCompletionsHeadersSchema,
        body: z.any(), // Flexible body to support multiple provider formats if needed, though OpenAI is standard
        response: constructResponseSchema(z.any()),
      },
      // Prefix is prepended by the parent registration if registered with prefix,
      // but here we define it clearly.
    },
    async (request, reply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        reply.code(401).send({
          error: {
            message: "Authentication required. Use a platform virtual API key.",
            type: "invalid_request_error",
            code: "authentication_failed",
          },
        });
        return;
      }

      const token = authHeader.replace("Bearer ", "");
      
      try {
        // 1. Resolve provider from token (token, expectedProvider=null)
        const virtualResult = await validateVirtualApiKey(token, null);
        const providerName = virtualResult.provider;
        const factory = providerRegistry[providerName];

        if (!factory) {
          reply.code(400).send({
            error: {
              message: `Provider "${providerName}" resolved from virtual key is not supported by the unified proxy.`,
              type: "invalid_request_error",
              code: "unsupported_provider",
            },
          });
          return;
        }

        logger.info(
          { providerName, url: request.url },
          "[UnifiedProxy] Routing unified request to provider adapter",
        );

        // 2. Delegate to generic LLM Proxy handler with the resolved factory
        return handleLLMProxy(request.body, request, reply, factory);
      } catch (error: any) {
        logger.error(
          { error: error.message, url: request.url },
          "[UnifiedProxy] Unified request failed",
        );
        throw error;
      }
    },
  );
};

export default unifiedProxyRoutes;

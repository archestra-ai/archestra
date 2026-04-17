import type { FastifyRequest } from "fastify";
import type { OpenAi } from "@/types";
import type {
  CreateClientOptions,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
} from "@/types";
import type { SupportedProvider } from "@shared";

// Import all adapter factories
import { anthropicAdapterFactory } from "./anthropic";
import { azureAdapterFactory } from "./azure";
import { bedrockAdapterFactory } from "./bedrock";
import { cerebrasAdapterFactory } from "./cerebras";
import { cohereAdapterFactory } from "./cohere";
import { deepseekAdapterFactory } from "./deepseek";
import { geminiAdapterFactory } from "./gemini";
import { groqAdapterFactory } from "./groq";
import { minimaxAdapterFactory } from "./minimax";
import { mistralAdapterFactory } from "./mistral";
import { ollamaAdapterFactory } from "./ollama";
import { openaiAdapterFactory } from "./openai";
import { openrouterAdapterFactory } from "./openrouter";
import { perplexityAdapterFactory } from "./perplexity";
import { vllmAdapterFactory } from "./vllm";
import { xaiAdapterFactory } from "./xai";
import { zhipuaiAdapterFactory } from "./zhipuai";

// =============================================================================
// MODEL ROUTING
// =============================================================================

/**
 * Resolves a model name to its target provider adapter factory.
 * Follows the routing table defined in the architecture plan.
 */
function resolveProviderFactory(model: string | undefined): LLMProvider<any, any, any, any, any> {
  const m = (model || "").toLowerCase();

  // Anthropic
  if (m.startsWith("claude-")) {
    return anthropicAdapterFactory;
  }
  // Gemini
  if (m.startsWith("gemini-") || m.startsWith("gemma-")) {
    return geminiAdapterFactory;
  }
  // Cohere
  if (m.startsWith("command-")) {
    return cohereAdapterFactory;
  }
  // Bedrock
  if (m.startsWith("amazon.") || m.startsWith("anthropic.claude-")) {
    return bedrockAdapterFactory;
  }
  // xAI
  if (m.startsWith("grok-")) {
    return xaiAdapterFactory;
  }
  // Perplexity
  if (m.startsWith("sonar")) {
    return perplexityAdapterFactory;
  }
  // Mistral
  if (m.startsWith("mistral-") || m.startsWith("ministral-")) {
    return mistralAdapterFactory;
  }
  // Cerebras
  if (m.startsWith("cerebras") || m.startsWith("llama-3.3-70b")) {
    // Note: llama is hosted by many, but we route cerebras patterns or fallback
    return cerebrasAdapterFactory;
  }
  // Deepseek
  if (m.startsWith("deepseek-")) {
    return deepseekAdapterFactory;
  }
  // Groq
  if (m.startsWith("llama-") && m.includes("instant")) {
    return groqAdapterFactory;
  }
  
  // Default fallback: OpenAI pattern (gpt-*, o1-*, o3-*) and anything else
  return openaiAdapterFactory;
}

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

/**
 * The Unified Adapter acts as a meta-router.
 * It does not have its own request/response logic. Instead, it inspects the request,
 * determines the appropriate provider based on the requested model, and delegates
 * all LLMProvider interface methods to that provider's adapter.
 */
export const unifiedAdapterFactory: LLMProvider<
  any,
  any,
  any,
  any,
  any
> = {
  provider: "unified",
  interactionType: "unified:chatCompletions",
  spanName: "chat",

  createRequestAdapter(request: any): LLMRequestAdapter<any, any> {
    const model = request?.model;
    const factory = resolveProviderFactory(model);
    return factory.createRequestAdapter(request);
  },

  createResponseAdapter(response: any): LLMResponseAdapter<any> {
    const model = response?.model;
    const factory = resolveProviderFactory(model);
    return factory.createResponseAdapter(response);
  },

  createStreamAdapter(request?: any): LLMStreamAdapter<any, any> {
    const model = request?.model;
    const factory = resolveProviderFactory(model);
    return factory.createStreamAdapter(request);
  },

  extractApiKey(headers: any): string | undefined {
    // Since unified uses OpenAI format, we try to extract via the OpenAI logic
    return openaiAdapterFactory.extractApiKey(headers);
  },

  getBaseUrl(): string | undefined {
    return undefined;
  },

  createClient(apiKey: string | undefined, options: CreateClientOptions): unknown {
    const model = options.defaultHeaders?.["x-archestra-model"];
    const factory = resolveProviderFactory(model);
    return factory.createClient(apiKey, options);
  },

  execute(client: unknown, request: any): Promise<any> {
    const model = request?.model;
    const factory = resolveProviderFactory(model);
    return factory.execute(client, request);
  },

  executeStream(client: unknown, request: any): Promise<AsyncIterable<any>> {
    const model = request?.model;
    const factory = resolveProviderFactory(model);
    return factory.executeStream(client, request);
  },

  extractErrorMessage(error: unknown): string {
    return openaiAdapterFactory.extractErrorMessage(error);
  },
};

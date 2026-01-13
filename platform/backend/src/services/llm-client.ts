import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  EXTERNAL_AGENT_ID_HEADER,
  SESSION_ID_HEADER,
  USER_ID_HEADER,
} from "@shared";
import type { streamText } from "ai";
import config from "@/config";
import logger from "@/logging";
import { ChatApiKeyModel, TeamModel } from "@/models";
import { isVertexAiEnabled } from "@/routes/proxy/utils/gemini-client";
import { secretManager } from "@/secrets-manager";
import { ApiError, type SupportedChatProvider } from "@/types";

/**
 * Note: vLLM and Ollama use the @ai-sdk/openai provider since they expose OpenAI-compatible APIs.
 * When creating a vLLM/Ollama model, we use createOpenAI with the respective base URL.
 */

/**
 * Type representing a model that can be passed to streamText/generateText
 */
export type LLMModel = Parameters<typeof streamText>[0]["model"];

/**
 * Detect which provider a model belongs to based on its name
 * It's a recommended to rely on explicit provider selection whenever possible,
 * Since same models could be served by different providers.
 * Currently it exists for backward compatibility.
 *
 * Note: vLLM and Ollama can serve any model, so they cannot be auto-detected by model name.
 * Users must explicitly select vLLM or Ollama as the provider.
 */
export function detectProviderFromModel(model: string): SupportedChatProvider {
  const lowerModel = model.toLowerCase();

  if (lowerModel.includes("claude")) {
    return "anthropic";
  }

  if (lowerModel.includes("gemini") || lowerModel.includes("google")) {
    return "gemini";
  }

  if (
    lowerModel.includes("gpt") ||
    lowerModel.includes("o1") ||
    lowerModel.includes("o3")
  ) {
    return "openai";
  }

  // Default to anthropic for backwards compatibility
  // Note: vLLM and Ollama cannot be auto-detected as they can serve any model
  return "anthropic";
}

/**
 * Resolve API key for a provider using priority:
 * conversation > personal > team > org_wide > environment variable
 */
export async function resolveProviderApiKey(params: {
  organizationId: string;
  userId: string;
  provider: SupportedChatProvider;
  conversationId?: string | null;
}): Promise<{ apiKey: string | undefined; source: string }> {
  const { organizationId, userId, provider, conversationId } = params;

  let providerApiKey: string | undefined;
  let apiKeySource = "environment";

  // Get user's team IDs for API key resolution
  const userTeamIds = await TeamModel.getUserTeamIds(userId);

  // Try scope-based resolution (checks conversation's chatApiKeyId first, then personal > team > org_wide)
  const resolvedApiKey = await ChatApiKeyModel.getCurrentApiKey({
    organizationId,
    userId,
    userTeamIds,
    provider,
    conversationId: conversationId ?? null,
  });

  if (resolvedApiKey?.secretId) {
    const secret = await secretManager().getSecret(resolvedApiKey.secretId);
    // Support both old format (anthropicApiKey) and new format (apiKey)
    const secretValue =
      secret?.secret?.apiKey ??
      secret?.secret?.anthropicApiKey ??
      secret?.secret?.geminiApiKey ??
      secret?.secret?.openaiApiKey;
    if (secretValue) {
      providerApiKey = secretValue as string;
      apiKeySource = resolvedApiKey.scope;
    }
  }

  // Fall back to environment variable
  if (!providerApiKey) {
    if (provider === "anthropic" && config.chat.anthropic.apiKey) {
      providerApiKey = config.chat.anthropic.apiKey;
      apiKeySource = "environment";
    } else if (provider === "cerebras" && config.chat.cerebras.apiKey) {
      providerApiKey = config.chat.cerebras.apiKey;
      apiKeySource = "environment";
    } else if (provider === "openai" && config.chat.openai.apiKey) {
      providerApiKey = config.chat.openai.apiKey;
      apiKeySource = "environment";
    } else if (provider === "gemini" && config.chat.gemini.apiKey) {
      providerApiKey = config.chat.gemini.apiKey;
      apiKeySource = "environment";
    } else if (provider === "vllm" && config.chat.vllm.apiKey) {
      providerApiKey = config.chat.vllm.apiKey;
      apiKeySource = "environment";
    } else if (provider === "ollama" && config.chat.ollama.apiKey) {
      providerApiKey = config.chat.ollama.apiKey;
      apiKeySource = "environment";
    }
  }

  return { apiKey: providerApiKey, source: apiKeySource };
}

/**
 * Check if API key is required for the given provider
 */
export function isApiKeyRequired(
  provider: SupportedChatProvider,
  apiKey: string | undefined,
): boolean {
  // For Gemini with Vertex AI enabled, API key is not required
  const isGeminiWithVertexAi = provider === "gemini" && isVertexAiEnabled();
  // vLLM and Ollama typically don't require API keys (use "EMPTY" or dummy values)
  const isVllm = provider === "vllm";
  const isOllama = provider === "ollama";
  return !apiKey && !isGeminiWithVertexAi && !isVllm && !isOllama;
}

/**
 * Create an LLM model for the specified provider, pointing to the LLM Proxy
 * Returns a model instance ready to use with streamText/generateText
 */
export function createLLMModel(params: {
  provider: SupportedChatProvider;
  apiKey: string | undefined;
  agentId: string;
  modelName: string;
  userId?: string;
  externalAgentId?: string;
  sessionId?: string;
}): LLMModel {
  const {
    provider,
    apiKey,
    agentId,
    modelName,
    userId,
    externalAgentId,
    sessionId,
  } = params;

  // Build headers for LLM Proxy
  const clientHeaders: Record<string, string> = {};
  if (externalAgentId) {
    clientHeaders[EXTERNAL_AGENT_ID_HEADER] = externalAgentId;
  }
  if (userId) {
    clientHeaders[USER_ID_HEADER] = userId;
  }
  if (sessionId) {
    clientHeaders[SESSION_ID_HEADER] = sessionId;
  }

  const headers =
    Object.keys(clientHeaders).length > 0 ? clientHeaders : undefined;

  if (provider === "anthropic") {
    // URL format: /v1/anthropic/:agentId/v1/messages
    const client = createAnthropic({
      apiKey,
      baseURL: `http://localhost:${config.api.port}/v1/anthropic/${agentId}/v1`,
      headers,
    });
    return client(modelName);
  }

  if (provider === "gemini") {
    // URL format: /v1/gemini/:agentId/v1beta/models
    // For Vertex AI mode, pass a placeholder - the LLM Proxy uses ADC for auth
    const client = createGoogleGenerativeAI({
      apiKey: apiKey || "vertex-ai-mode",
      baseURL: `http://localhost:${config.api.port}/v1/gemini/${agentId}/v1beta`,
      headers,
    });
    return client(modelName);
  }

  if (provider === "openai") {
    // URL format: /v1/openai/:agentId (SDK appends /chat/completions)
    const client = createOpenAI({
      apiKey,
      baseURL: `http://localhost:${config.api.port}/v1/openai/${agentId}`,
      headers,
    });
    // Use .chat() to force Chat Completions API (not Responses API)
    // so our proxy's tool policy evaluation is applied
    return client.chat(modelName);
  }

  if (provider === "cerebras") {
    // URL format: /v1/cerebras/:agentId (SDK appends /chat/completions)
    const client = createCerebras({
      apiKey,
      baseURL: `http://localhost:${config.api.port}/v1/cerebras/${agentId}`,
      headers,
    });
    return client(modelName);
  }

  if (provider === "vllm") {
    // URL format: /v1/vllm/:agentId (SDK appends /chat/completions)
    // vLLM uses OpenAI-compatible API, so we use the OpenAI SDK
    const client = createOpenAI({
      apiKey: apiKey || "EMPTY", // vLLM typically doesn't require API keys
      baseURL: `http://localhost:${config.api.port}/v1/vllm/${agentId}`,
      headers,
    });
    // Use .chat() to force Chat Completions API
    return client.chat(modelName);
  }

  if (provider === "ollama") {
    // URL format: /v1/ollama/:agentId (SDK appends /chat/completions)
    // Ollama uses OpenAI-compatible API, so we use the OpenAI SDK
    const client = createOpenAI({
      apiKey: apiKey || "EMPTY", // Ollama typically doesn't require API keys
      baseURL: `http://localhost:${config.api.port}/v1/ollama/${agentId}`,
      headers,
    });
    // Use .chat() to force Chat Completions API
    return client.chat(modelName);
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

/**
 * Full helper to resolve API key and create LLM model.
 * Provider must be explicitly passed - callers can use detectProviderFromModel
 * as a fallback for backward compatibility with existing conversations.
 */
export async function createLLMModelForAgent(params: {
  organizationId: string;
  userId: string;
  agentId: string;
  model: string;
  provider: SupportedChatProvider;
  conversationId?: string | null;
  externalAgentId?: string;
  sessionId?: string;
}): Promise<{
  model: LLMModel;
  provider: SupportedChatProvider;
  apiKeySource: string;
}> {
  const {
    organizationId,
    userId,
    agentId,
    model: modelName,
    provider,
    conversationId,
    externalAgentId,
    sessionId,
  } = params;

  const { apiKey, source } = await resolveProviderApiKey({
    organizationId,
    userId,
    provider,
    conversationId,
  });

  // Check if Gemini with Vertex AI (doesn't require API key)
  const isGeminiWithVertexAi = provider === "gemini" && isVertexAiEnabled();
  // vLLM and Ollama typically don't require API keys
  const isVllm = provider === "vllm";
  const isOllama = provider === "ollama";

  logger.info(
    { apiKeySource: source, provider, isGeminiWithVertexAi, isVllm, isOllama },
    "Using LLM provider API key",
  );

  if (!apiKey && !isGeminiWithVertexAi && !isVllm && !isOllama) {
    throw new ApiError(
      400,
      "LLM Provider API key not configured. Please configure it in Chat Settings.",
    );
  }

  const model = createLLMModel({
    provider,
    apiKey,
    agentId,
    modelName,
    userId,
    externalAgentId,
    sessionId,
  });

  return { model, provider, apiKeySource: source };
}

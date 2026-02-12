import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import {
  EXTERNAL_AGENT_ID_HEADER,
  SESSION_ID_HEADER,
  USER_ID_HEADER,
} from "@shared";
import type { streamText } from "ai";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import config from "@/config";
import logger from "@/logging";
import { ChatApiKeyModel, TeamModel } from "@/models";
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
 * @deprecated DO NOT USE THIS FUNCTION FOR NEW CODE.
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

  if (lowerModel.includes("command")) {
    return "cohere";
  }
  if (lowerModel.includes("glm") || lowerModel.includes("chatglm")) {
    return "zhipuai";
  }

  // Default to anthropic for backwards compatibility
  // Note: vLLM and Ollama cannot be auto-detected as they can serve any model
  return "anthropic";
}

/**
 * Environment variable API key getter for each provider.
 * TypeScript enforces that ALL providers in SupportedChatProvider have an entry.
 */
const envApiKeyGetters: Record<
  SupportedChatProvider,
  () => string | undefined
> = {
  anthropic: () => config.chat.anthropic.apiKey,
  bedrock: () => config.chat.bedrock.apiKey,
  cerebras: () => config.chat.cerebras.apiKey,
  cohere: () => config.chat.cohere.apiKey,
  gemini: () => config.chat.gemini.apiKey,
  mistral: () => config.chat.mistral.apiKey,
  ollama: () => config.chat.ollama.apiKey,
  openai: () => config.chat.openai.apiKey,
  vllm: () => config.chat.vllm.apiKey,
  zhipuai: () => config.chat.zhipuai.apiKey,
};

/**
 * Resolve API key for a provider using priority:
 * agent's configured key > conversation > personal > team > org_wide > environment variable
 *
 * When userId is provided: resolves via getCurrentApiKey (agent key > personal > team > org_wide).
 * When no userId: checks org_wide keys only.
 */
export async function resolveProviderApiKey(params: {
  organizationId: string;
  userId?: string;
  provider: SupportedChatProvider;
  conversationId?: string | null;
  agentLlmApiKeyId?: string | null;
}): Promise<{
  apiKey: string | undefined;
  source: string;
  chatApiKeyId: string | undefined;
}> {
  const { organizationId, userId, provider, conversationId, agentLlmApiKeyId } =
    params;

  // Try scope-based resolution
  let resolvedApiKey: {
    id: string;
    secretId: string | null;
    scope: string;
  } | null = null;

  if (userId) {
    const userTeamIds = await TeamModel.getUserTeamIds(userId);
    resolvedApiKey = await ChatApiKeyModel.getCurrentApiKey({
      organizationId,
      userId,
      userTeamIds,
      provider,
      conversationId: conversationId ?? null,
      agentLlmApiKeyId,
    });
  } else {
    resolvedApiKey = await ChatApiKeyModel.findByScope(
      organizationId,
      provider,
      "org_wide",
    );
  }

  if (resolvedApiKey?.secretId) {
    const secret = await secretManager().getSecret(resolvedApiKey.secretId);
    // Support both old format (anthropicApiKey) and new format (apiKey)
    const secretValue =
      secret?.secret?.apiKey ??
      secret?.secret?.anthropicApiKey ??
      secret?.secret?.geminiApiKey ??
      secret?.secret?.openaiApiKey ??
      secret?.secret?.zhipuaiApiKey ??
      secret?.secret?.cohereApiKey ??
      secret?.secret?.bedrockApiKey;
    if (secretValue) {
      return {
        apiKey: secretValue as string,
        source: resolvedApiKey.scope,
        chatApiKeyId: resolvedApiKey.id,
      };
    }
  }

  // Fall back to environment variable
  const envApiKey = envApiKeyGetters[provider]();
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      source: "environment",
      chatApiKeyId: undefined,
    };
  }

  return { apiKey: undefined, source: "environment", chatApiKeyId: undefined };
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
 * Fast models for each provider, used for title generation and other quick operations.
 * These are optimized for speed and cost rather than capability.
 *
 * TODO: Replace this hardcoded map with fast model values from the models database table.
 */
export const FAST_MODELS: Record<SupportedChatProvider, string> = {
  anthropic: "claude-3-5-haiku-20241022",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash-001",
  cerebras: "llama-3.3-70b", // Cerebras focuses on speed, all their models are fast
  cohere: "command-light", // Cohere's fast model
  vllm: "default", // vLLM uses whatever model is deployed
  ollama: "llama3.2", // Common fast model for Ollama
  zhipuai: "glm-4-flash", // Zhipu's fast model
  bedrock: "amazon.nova-lite-v1:0", // Bedrock's fast model, available in all regions for on-demand inference
  mistral: "mistral-small-latest", // Mistral's fast model
};

/**
 * Parameters for creating a direct LLM model (calls provider API directly)
 */
type DirectModelParams = {
  apiKey: string | undefined;
  modelName: string;
};

/**
 * Model creator function type for direct API calls
 */
type DirectModelCreator = (params: DirectModelParams) => LLMModel;

/**
 * Registry of direct model creators for each provider.
 * TypeScript enforces that ALL providers in SupportedChatProvider have an entry.
 * Adding a new provider to SupportedChatProvider will cause a compile error here
 * until the corresponding creator is added.
 */
const directModelCreators: Record<SupportedChatProvider, DirectModelCreator> = {
  anthropic: ({ apiKey, modelName }) => {
    if (!apiKey) {
      throw new ApiError(
        400,
        "Anthropic API key is required. Please configure ANTHROPIC_API_KEY.",
      );
    }
    const client = createAnthropic({ apiKey });
    return client(modelName);
  },

  openai: ({ apiKey, modelName }) => {
    if (!apiKey) {
      throw new ApiError(
        400,
        "OpenAI API key is required. Please configure OPENAI_API_KEY.",
      );
    }
    const client = createOpenAI({ apiKey });
    return client(modelName);
  },

  gemini: ({ apiKey, modelName }) => {
    // Check if Vertex AI mode is enabled
    if (isVertexAiEnabled()) {
      const { vertexAi } = config.llm.gemini;
      const client = createVertex({
        project: vertexAi.project,
        location: vertexAi.location,
        googleAuthOptions: {
          projectId: vertexAi.project,
          ...(vertexAi.credentialsFile && {
            keyFilename: vertexAi.credentialsFile,
          }),
        },
      });
      return client(modelName);
    }
    if (!apiKey) {
      throw new ApiError(
        400,
        "Gemini API key is required when Vertex AI is not enabled. Please configure GEMINI_API_KEY or enable Vertex AI.",
      );
    }
    const client = createGoogleGenerativeAI({ apiKey });
    return client(modelName);
  },

  cerebras: ({ apiKey, modelName }) => {
    if (!apiKey) {
      throw new ApiError(
        400,
        "Cerebras API key is required. Please configure CEREBRAS_API_KEY.",
      );
    }
    const client = createCerebras({
      apiKey,
      baseURL: config.llm.cerebras.baseUrl,
    });
    return client(modelName);
  },

  cohere: ({ apiKey, modelName }) => {
    if (!apiKey) {
      throw new ApiError(
        400,
        "Cohere API key is required. Please configure COHERE_API_KEY.",
      );
    }
    const client = createCohere({
      apiKey,
      baseURL: config.llm.cohere.baseUrl,
    });
    return client(modelName);
  },

  mistral: ({ apiKey, modelName }) => {
    if (!apiKey) {
      throw new ApiError(
        400,
        "Mistral API key is required. Please configure MISTRAL_API_KEY.",
      );
    }
    const client = createMistral({
      apiKey,
      baseURL: config.llm.mistral.baseUrl,
    });
    return client(modelName);
  },

  vllm: ({ apiKey, modelName }) => {
    // vLLM uses OpenAI-compatible API
    const client = createOpenAI({
      apiKey: apiKey || "EMPTY",
      baseURL: config.llm.vllm.baseUrl,
    });
    return client(modelName);
  },

  ollama: ({ apiKey, modelName }) => {
    // Ollama uses OpenAI-compatible API
    const client = createOpenAI({
      apiKey: apiKey || "EMPTY",
      baseURL: config.llm.ollama.baseUrl,
    });
    return client(modelName);
  },

  zhipuai: ({ apiKey, modelName }) => {
    if (!apiKey) {
      throw new ApiError(
        400,
        "Zhipu AI API key is required. Please configure ZHIPUAI_API_KEY.",
      );
    }
    // Zhipu AI uses OpenAI-compatible API
    const client = createOpenAI({
      apiKey,
      baseURL: config.llm.zhipuai.baseUrl,
    });
    return client(modelName);
  },

  bedrock: ({ apiKey, modelName }) => {
    if (!apiKey) {
      throw new ApiError(
        400,
        "Amazon Bedrock API key is required. Please configure ARCHESTRA_CHAT_BEDROCK_API_KEY.",
      );
    }
    // Extract region from Bedrock base URL if configured
    const baseUrl = config.llm.bedrock.baseUrl;
    const regionMatch = baseUrl.match(/bedrock-runtime\.([a-z0-9-]+)\./);
    const region = regionMatch?.[1] || "us-east-1";

    const client = createAmazonBedrock({
      apiKey,
      region,
      baseURL: config.llm.bedrock.baseUrl,
      secretAccessKey: undefined,
      accessKeyId: undefined,
      sessionToken: undefined,
      credentialProvider: undefined,
    });
    return client(modelName);
  },
};

/**
 * Create an LLM model that calls the provider API directly (not through LLM Proxy).
 * Use this for meta operations like title generation that don't need proxy features.
 */
export function createDirectLLMModel({
  provider,
  apiKey,
  modelName,
}: {
  provider: SupportedChatProvider;
  apiKey: string | undefined;
  modelName: string;
}): LLMModel {
  const creator = directModelCreators[provider];
  if (!creator) {
    throw new ApiError(400, `Unsupported provider: ${provider}`);
  }
  return creator({ apiKey, modelName });
}

/**
 * Parameters for creating a proxied LLM model (through LLM Proxy)
 */
type ProxiedModelParams = {
  apiKey: string | undefined;
  agentId: string;
  modelName: string;
  headers: Record<string, string> | undefined;
};

/**
 * Model creator function type for proxied API calls
 */
type ProxiedModelCreator = (params: ProxiedModelParams) => LLMModel;

/**
 * Build the proxy base URL for a provider
 */
function buildProxyBaseUrl(provider: string, agentId: string): string {
  return `http://localhost:${config.api.port}/v1/${provider}/${agentId}`;
}

/**
 * Registry of proxied model creators for each provider.
 * TypeScript enforces that ALL providers in SupportedChatProvider have an entry.
 * Adding a new provider to SupportedChatProvider will cause a compile error here
 * until the corresponding creator is added.
 */
const proxiedModelCreators: Record<SupportedChatProvider, ProxiedModelCreator> =
  {
    anthropic: ({ apiKey, agentId, modelName, headers }) => {
      // URL format: /v1/anthropic/:agentId/v1/messages
      const client = createAnthropic({
        apiKey,
        baseURL: `${buildProxyBaseUrl("anthropic", agentId)}/v1`,
        headers,
      });
      return client(modelName);
    },

    gemini: ({ apiKey, agentId, modelName, headers }) => {
      // URL format: /v1/gemini/:agentId/v1beta/models
      // For Vertex AI mode, pass a placeholder - the LLM Proxy uses ADC for auth
      const client = createGoogleGenerativeAI({
        apiKey: apiKey || "vertex-ai-mode",
        baseURL: `${buildProxyBaseUrl("gemini", agentId)}/v1beta`,
        headers,
      });
      return client(modelName);
    },

    openai: ({ apiKey, agentId, modelName, headers }) => {
      // URL format: /v1/openai/:agentId (SDK appends /chat/completions)
      const client = createOpenAI({
        apiKey,
        baseURL: buildProxyBaseUrl("openai", agentId),
        headers,
      });
      // Use .chat() to force Chat Completions API (not Responses API)
      // so our proxy's tool policy evaluation is applied
      return client.chat(modelName);
    },

    cohere: ({ apiKey, agentId, modelName, headers }) => {
      // URL format: /v1/cohere/:agentId (SDK appends /chat)
      // We use the native Cohere provider which uses the V2 API
      const client = createCohere({
        apiKey,
        baseURL: buildProxyBaseUrl("cohere", agentId),
        headers,
      });
      return client(modelName);
    },

    cerebras: ({ apiKey, agentId, modelName, headers }) => {
      // URL format: /v1/cerebras/:agentId (SDK appends /chat/completions)
      const client = createCerebras({
        apiKey,
        baseURL: buildProxyBaseUrl("cerebras", agentId),
        headers,
      });
      return client(modelName);
    },

    mistral: ({ apiKey, agentId, modelName, headers }) => {
      // URL format: /v1/mistral/:agentId (SDK appends /chat/completions)
      const client = createMistral({
        apiKey,
        baseURL: buildProxyBaseUrl("mistral", agentId),
        headers,
      });
      return client(modelName);
    },

    vllm: ({ apiKey, agentId, modelName, headers }) => {
      // URL format: /v1/vllm/:agentId (SDK appends /chat/completions)
      // vLLM uses OpenAI-compatible API, so we use the OpenAI SDK
      const client = createOpenAI({
        apiKey: apiKey || "EMPTY", // vLLM typically doesn't require API keys
        baseURL: buildProxyBaseUrl("vllm", agentId),
        headers,
      });
      // Use .chat() to force Chat Completions API
      return client.chat(modelName);
    },

    ollama: ({ apiKey, agentId, modelName, headers }) => {
      // URL format: /v1/ollama/:agentId (SDK appends /chat/completions)
      // Ollama uses OpenAI-compatible API, so we use the OpenAI SDK
      const client = createOpenAI({
        apiKey: apiKey || "EMPTY", // Ollama typically doesn't require API keys
        baseURL: buildProxyBaseUrl("ollama", agentId),
        headers,
      });
      // Use .chat() to force Chat Completions API
      return client.chat(modelName);
    },

    zhipuai: ({ apiKey, agentId, modelName, headers }) => {
      // URL format: /v1/zhipuai/:agentId (SDK appends /chat/completions)
      // Zhipuai is OpenAI-compatible, so we use the OpenAI SDK with custom baseURL
      const client = createOpenAI({
        apiKey,
        baseURL: buildProxyBaseUrl("zhipuai", agentId),
        headers,
      });
      return client.chat(modelName);
    },

    bedrock: ({ apiKey, agentId, modelName, headers }) => {
      // URL format: /v1/bedrock/:agentId (SDK appends /converse)
      // Bedrock uses Bearer token auth through the proxy
      const client = createAmazonBedrock({
        apiKey, // Bearer token for proxy authentication
        region: "us-east-1", // Placeholder - proxy extracts actual region from base URL
        baseURL: buildProxyBaseUrl("bedrock", agentId),
        secretAccessKey: undefined,
        accessKeyId: undefined,
        sessionToken: undefined,
        credentialProvider: undefined,
        headers,
      });
      return client(modelName);
    },
  };

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

  const creator = proxiedModelCreators[provider];
  return creator({ apiKey, agentId, modelName, headers });
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
  agentLlmApiKeyId?: string | null;
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
    agentLlmApiKeyId,
  } = params;

  const { apiKey, source } = await resolveProviderApiKey({
    organizationId,
    userId,
    provider,
    conversationId,
    agentLlmApiKeyId,
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

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { context, propagation } from "@opentelemetry/api";
import type { InteractionSource } from "@shared";
import {
  EXTERNAL_AGENT_ID_HEADER,
  PROVIDER_BASE_URL_HEADER,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
  SESSION_ID_HEADER,
  SOURCE_HEADER,
  type SupportedProvider,
  USER_ID_HEADER,
} from "@shared";
import type { streamText } from "ai";
import {
  getBedrockCredentialProvider,
  getBedrockRegion,
  isBedrockIamAuthEnabled,
} from "@/clients/bedrock-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import config from "@/config";
import logger from "@/logging";
import { ChatApiKeyModel, TeamModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { ApiError } from "@/types";

/**
 * Placeholder API key for providers that don't require authentication (vLLM, Ollama).
 * The OpenAI SDK requires a non-empty apiKey string, so we pass this sentinel value.
 */
const KEYLESS_PROVIDER_API_KEY_PLACEHOLDER = "EMPTY";

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
export function detectProviderFromModel(model: string): SupportedProvider {
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

  if (lowerModel.includes("minimax")) {
    return "minimax";
  }

  if (lowerModel.includes("deepseek")) {
    return "deepseek";
  }

  // Default to anthropic for backwards compatibility
  // Note: vLLM and Ollama cannot be auto-detected as they can serve any model
  return "anthropic";
}

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
  provider: SupportedProvider;
  conversationId?: string | null;
  agentLlmApiKeyId?: string | null;
}): Promise<{
  apiKey: string | undefined;
  source: string;
  chatApiKeyId: string | undefined;
  baseUrl: string | null;
}> {
  const { organizationId, userId, provider, conversationId, agentLlmApiKeyId } =
    params;

  // Try scope-based resolution
  let resolvedApiKey: {
    id: string;
    secretId: string | null;
    scope: string;
    baseUrl: string | null;
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

  if (resolvedApiKey) {
    if (resolvedApiKey.secretId) {
      const secretValue = await getSecretValueForLlmProviderApiKey(
        resolvedApiKey.secretId,
      );
      if (secretValue) {
        return {
          apiKey: secretValue as string,
          source: resolvedApiKey.scope,
          chatApiKeyId: resolvedApiKey.id,
          baseUrl: resolvedApiKey.baseUrl,
        };
      }
    }

    // Key exists but has no secret (e.g. Ollama, vLLM with optional API key).
    // Return the resolved key so the caller gets the baseUrl and chatApiKeyId.
    if (PROVIDERS_WITH_OPTIONAL_API_KEY.has(provider)) {
      return {
        apiKey: undefined,
        source: resolvedApiKey.scope,
        chatApiKeyId: resolvedApiKey.id,
        baseUrl: resolvedApiKey.baseUrl,
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
      baseUrl: null,
    };
  }

  return {
    apiKey: undefined,
    source: "environment",
    chatApiKeyId: undefined,
    baseUrl: null,
  };
}

/**
 * Check if API key is required for the given provider
 */
export function isApiKeyRequired(
  provider: SupportedProvider,
  apiKey: string | undefined,
): boolean {
  if (apiKey) return false;
  // Gemini with Vertex AI doesn't require an API key
  if (provider === "gemini" && isVertexAiEnabled()) return false;
  return !!providerModelConfigs[provider].apiKeyRequiredMessage;
}

/**
 * Create an LLM model that calls the provider API directly (not through LLM Proxy).
 * Use this for meta operations like title generation that don't need proxy features.
 */
export function createDirectLLMModel({
  provider,
  apiKey,
  modelName,
  baseUrl,
}: {
  provider: SupportedProvider;
  apiKey: string | undefined;
  modelName: string;
  baseUrl: string | null;
}): LLMModel {
  const cfg = providerModelConfigs[provider];
  if (!cfg) {
    throw new ApiError(400, `Unsupported provider: ${provider}`);
  }
  if (cfg.apiKeyRequiredMessage && !apiKey) {
    throw new ApiError(400, cfg.apiKeyRequiredMessage);
  }
  const resolvedBaseUrl = baseUrl ?? cfg.defaultBaseUrl;
  const baseURL =
    resolvedBaseUrl && cfg.proxiedPathSuffix
      ? `${resolvedBaseUrl}${cfg.proxiedPathSuffix}`
      : resolvedBaseUrl;
  return cfg.createModel({
    apiKey,
    modelName,
    baseURL,
  });
}

/**
 * Create an LLM model for the specified provider, pointing to the LLM Proxy
 * Returns a model instance ready to use with streamText/generateText
 */
export function createLLMModel(params: {
  provider: SupportedProvider;
  apiKey: string | undefined;
  agentId: string;
  modelName: string;
  userId?: string;
  externalAgentId?: string;
  sessionId?: string;
  source?: InteractionSource;
  baseUrl: string | null;
}): LLMModel {
  const {
    provider,
    apiKey,
    agentId,
    modelName,
    userId,
    externalAgentId,
    sessionId,
    source,
    baseUrl,
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
  if (source) {
    clientHeaders[SOURCE_HEADER] = source;
  }
  if (baseUrl) {
    clientHeaders[PROVIDER_BASE_URL_HEADER] = baseUrl;
  }

  const headers =
    Object.keys(clientHeaders).length > 0 ? clientHeaders : undefined;

  const cfg = providerModelConfigs[provider];
  const proxyBaseUrl = buildProxyBaseUrl(provider, agentId);
  const baseURL = cfg.proxiedPathSuffix
    ? `${proxyBaseUrl}${cfg.proxiedPathSuffix}`
    : proxyBaseUrl;

  return cfg.createModel({
    apiKey,
    modelName,
    baseURL,
    headers,
    fetch: createTracedFetch(),
  });
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
  provider: SupportedProvider;
  conversationId?: string | null;
  externalAgentId?: string;
  sessionId?: string;
  source?: InteractionSource;
  agentLlmApiKeyId?: string | null;
}): Promise<{
  model: LLMModel;
  provider: SupportedProvider;
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
    source,
    agentLlmApiKeyId,
  } = params;

  const {
    apiKey,
    source: apiKeySource,
    baseUrl,
  } = await resolveProviderApiKey({
    organizationId,
    userId,
    provider,
    conversationId,
    agentLlmApiKeyId,
  });

  // Check if Gemini with Vertex AI (doesn't require API key)
  const isGeminiWithVertexAi = provider === "gemini" && isVertexAiEnabled();
  // Check if Bedrock with IAM auth (doesn't require API key)
  const isBedrockWithIamAuth =
    provider === "bedrock" && isBedrockIamAuthEnabled();
  // vLLM and Ollama typically don't require API keys
  const isVllm = provider === "vllm";
  const isOllama = provider === "ollama";

  logger.info(
    {
      apiKeySource,
      provider,
      isGeminiWithVertexAi,
      isBedrockWithIamAuth,
      isVllm,
      isOllama,
    },
    "Using LLM provider API key",
  );

  if (
    !apiKey &&
    !isGeminiWithVertexAi &&
    !isBedrockWithIamAuth &&
    !isVllm &&
    !isOllama
  ) {
    throw new ApiError(
      400,
      "LLM Provider API key not configured. Please configure it in Provider Settings.",
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
    source,
    baseUrl,
  });

  return { model, provider, apiKeySource };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Environment variable API key getter for each provider.
 * TypeScript enforces that ALL providers in SupportedProvider have an entry.
 */
const envApiKeyGetters: Record<SupportedProvider, () => string | undefined> = {
  anthropic: () => config.chat.anthropic.apiKey,
  bedrock: () => config.chat.bedrock.apiKey,
  cerebras: () => config.chat.cerebras.apiKey,
  cohere: () => config.chat.cohere.apiKey,
  gemini: () => config.chat.gemini.apiKey,
  minimax: () => config.chat.minimax.apiKey,
  mistral: () => config.chat.mistral.apiKey,
  ollama: () => config.chat.ollama.apiKey,
  openai: () => config.chat.openai.apiKey,
  openrouter: () => config.chat.openrouter?.apiKey || undefined,
  perplexity: () => config.chat.perplexity.apiKey,
  groq: () => config.chat.groq.apiKey,
  xai: () => config.chat.xai.apiKey,
  vllm: () => config.chat.vllm.apiKey,
  zhipuai: () => config.chat.zhipuai.apiKey,
  deepseek: () => config.chat.deepseek.apiKey,
};

/**
 * Unified model creation config for each provider.
 * A single `createModel` function handles both direct and proxied calls.
 *
 * For direct calls: only apiKey, modelName, baseURL are provided.
 * For proxied calls: headers and fetch are also provided (for trace context injection).
 */
type ProviderModelConfig = {
  createModel: (params: {
    apiKey: string | undefined;
    modelName: string;
    baseURL: string | undefined;
    headers?: Record<string, string>;
    fetch?: typeof globalThis.fetch;
  }) => LLMModel;
  /** Default base URL for direct calls (falls back to provider's built-in default when undefined) */
  defaultBaseUrl: string | undefined;
  /** Error message when API key is missing. Undefined = key is optional (vllm, ollama). */
  apiKeyRequiredMessage?: string;
  /** Path suffix appended to proxy base URL for proxied calls (e.g. "/v1" for anthropic) */
  proxiedPathSuffix?: string;
};

/**
 * Unified registry of model configs for each provider.
 * TypeScript enforces that ALL providers in SupportedProvider have an entry.
 * Adding a new provider to SupportedProvider will cause a compile error here
 * until the corresponding config is added.
 */
const providerModelConfigs: Record<SupportedProvider, ProviderModelConfig> = {
  // --- Native SDK providers (use their own SDK, call client(modelName)) ---

  anthropic: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createAnthropic({ apiKey, baseURL, headers, fetch })(modelName),
    defaultBaseUrl: config.llm.anthropic.baseUrl,
    apiKeyRequiredMessage:
      "Anthropic API key is required. Please configure ANTHROPIC_API_KEY.",
    proxiedPathSuffix: "/v1",
  },

  cerebras: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createCerebras({ apiKey, baseURL, headers, fetch })(modelName),
    defaultBaseUrl: config.llm.cerebras.baseUrl,
    apiKeyRequiredMessage:
      "Cerebras API key is required. Please configure CEREBRAS_API_KEY.",
  },

  cohere: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createCohere({ apiKey, baseURL, headers, fetch })(modelName),
    defaultBaseUrl: config.llm.cohere.baseUrl,
    apiKeyRequiredMessage:
      "Cohere API key is required. Please configure COHERE_API_KEY.",
  },

  mistral: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createMistral({ apiKey, baseURL, headers, fetch })(modelName),
    defaultBaseUrl: config.llm.mistral.baseUrl,
    apiKeyRequiredMessage:
      "Mistral API key is required. Please configure MISTRAL_API_KEY.",
  },

  groq: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createGroq({ apiKey, baseURL, headers, fetch })(modelName),
    defaultBaseUrl: config.llm.groq.baseUrl,
    apiKeyRequiredMessage:
      "Groq API key is required. Please configure ARCHESTRA_CHAT_GROQ_API_KEY.",
  },

  xai: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createXai({ apiKey, baseURL, headers, fetch })(modelName),
    defaultBaseUrl: config.llm.xai.baseUrl,
    apiKeyRequiredMessage:
      "xAI API key is required. Please configure ARCHESTRA_CHAT_XAI_API_KEY.",
  },

  // --- OpenAI-compatible providers (use createOpenAI with .chat()) ---

  openai: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createOpenAI({ apiKey, baseURL, headers, fetch }).chat(modelName),
    defaultBaseUrl: config.llm.openai.baseUrl,
    apiKeyRequiredMessage:
      "OpenAI API key is required. Please configure OPENAI_API_KEY.",
  },

  openrouter: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createOpenAI({ apiKey, baseURL, headers, fetch }).chat(modelName),
    defaultBaseUrl: config.llm.openrouter.baseUrl,
    apiKeyRequiredMessage:
      "OpenRouter API key is required. Please configure ARCHESTRA_CHAT_OPENROUTER_API_KEY.",
  },

  perplexity: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createOpenAI({ apiKey, baseURL, headers, fetch }).chat(modelName),
    defaultBaseUrl: config.llm.perplexity.baseUrl,
    apiKeyRequiredMessage:
      "Perplexity API key is required. Please configure PERPLEXITY_API_KEY.",
  },

  zhipuai: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createOpenAI({ apiKey, baseURL, headers, fetch }).chat(modelName),
    defaultBaseUrl: config.llm.zhipuai.baseUrl,
    apiKeyRequiredMessage:
      "Zhipu AI API key is required. Please configure ZHIPUAI_API_KEY.",
  },

  minimax: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createOpenAI({ apiKey, baseURL, headers, fetch }).chat(modelName),
    defaultBaseUrl: config.llm.minimax.baseUrl,
    apiKeyRequiredMessage:
      "MiniMax API key is required. Please configure ARCHESTRA_CHAT_MINIMAX_API_KEY.",
  },

  deepseek: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createOpenAI({ apiKey, baseURL, headers, fetch }).chat(modelName),
    defaultBaseUrl: config.llm.deepseek.baseUrl,
    apiKeyRequiredMessage:
      "DeepSeek API key is required. Please configure DEEPSEEK_API_KEY.",
  },

  // --- OpenAI-compatible providers with optional API key ---

  vllm: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createOpenAI({
        apiKey: apiKey || KEYLESS_PROVIDER_API_KEY_PLACEHOLDER,
        baseURL,
        headers,
        fetch,
      }).chat(modelName),
    defaultBaseUrl: config.llm.vllm.baseUrl,
    // No apiKeyRequiredMessage — key is optional
  },

  ollama: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createOpenAI({
        apiKey: apiKey || KEYLESS_PROVIDER_API_KEY_PLACEHOLDER,
        baseURL,
        headers,
        fetch,
      }).chat(modelName),
    defaultBaseUrl: config.llm.ollama.baseUrl,
    // No apiKeyRequiredMessage — key is optional
  },

  // --- Special providers ---

  gemini: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) => {
      // Proxied path (headers/fetch provided): always use GoogleGenerativeAI
      if (headers || fetch) {
        return createGoogleGenerativeAI({
          apiKey: apiKey || "vertex-ai-mode",
          baseURL,
          headers,
          fetch,
        })(modelName);
      }
      // Direct path: use Vertex AI if enabled
      if (isVertexAiEnabled()) {
        const { vertexAi } = config.llm.gemini;
        return createVertex({
          project: vertexAi.project,
          location: vertexAi.location,
          googleAuthOptions: {
            projectId: vertexAi.project,
            ...(vertexAi.credentialsFile && {
              keyFilename: vertexAi.credentialsFile,
            }),
          },
        })(modelName);
      }
      // Direct path without Vertex AI — key is required
      if (!apiKey) {
        throw new ApiError(
          400,
          "Gemini API key is required when Vertex AI is not enabled. Please configure GEMINI_API_KEY or enable Vertex AI.",
        );
      }
      return createGoogleGenerativeAI({ apiKey, baseURL })(modelName);
    },
    defaultBaseUrl: undefined, // GoogleGenerativeAI has its own default
    // apiKeyRequiredMessage is undefined — validation is inside createModel (Vertex AI special case)
    proxiedPathSuffix: "/v1beta",
  },

  bedrock: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) => {
      const region = getBedrockRegion(baseURL);

      if (!apiKey && isBedrockIamAuthEnabled()) {
        return createAmazonBedrock({
          region,
          baseURL,
          credentialProvider: getBedrockCredentialProvider(),
          headers,
          fetch,
        })(modelName);
      }

      return createAmazonBedrock({
        apiKey,
        region,
        baseURL,
        secretAccessKey: undefined,
        accessKeyId: undefined,
        sessionToken: undefined,
        credentialProvider: undefined,
        headers,
        fetch,
      })(modelName);
    },
    defaultBaseUrl: config.llm.bedrock.baseUrl,
    apiKeyRequiredMessage: isBedrockIamAuthEnabled()
      ? undefined
      : "Amazon Bedrock API key is required. Please configure ARCHESTRA_CHAT_BEDROCK_API_KEY.",
  },
};

/**
 * Creates a fetch wrapper that injects W3C trace context (traceparent/tracestate)
 * into outgoing HTTP headers. This enables the LLM proxy handler to extract the
 * parent context and create child spans, linking chat → LLM proxy traces together.
 */
function createTracedFetch(): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    // Inject active trace context (traceparent, tracestate) into outgoing headers.
    // Uses a carrier object because propagation.inject expects a plain object,
    // then copies the injected headers into the actual Headers instance.
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    for (const [key, value] of Object.entries(carrier)) {
      headers.set(key, value);
    }
    return globalThis.fetch(input, { ...init, headers });
  };
}

/**
 * Build the proxy base URL for a provider
 */
function buildProxyBaseUrl(provider: string, agentId: string): string {
  return `http://localhost:${config.api.port}/v1/${provider}/${agentId}`;
}

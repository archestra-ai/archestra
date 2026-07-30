import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import type { InteractionSource } from "@archestra/shared";
import {
  anthropicThinksByDefault,
  CHAT_API_KEY_ID_HEADER,
  EXTERNAL_AGENT_ID_HEADER,
  isProviderApiKeyOptional,
  PROVIDER_BASE_URL_HEADER,
  providerRequiresPerUserCredential,
  requiresOpenAiResponsesApi,
  SESSION_ID_HEADER,
  SOURCE_HEADER,
  type SupportedProvider,
  UNTRUSTED_CONTEXT_HEADER,
  USER_ID_HEADER,
} from "@archestra/shared";
import { context, propagation } from "@opentelemetry/api";
import {
  extractReasoningMiddleware,
  type streamText,
  wrapLanguageModel,
} from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { isAnthropicNativeEndpoint } from "@/clients/anthropic-endpoint";
import { anthropicWorkloadIdentity } from "@/clients/anthropic-workload-identity";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import {
  createAzureFetchWithApiVersion,
  isAzureOpenAiFirstPartyModelName,
  normalizeAzureApiKey,
} from "@/clients/azure-url";
import {
  buildBedrockProvider,
  isBedrockIamAuthEnabled,
} from "@/clients/bedrock-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { getLlmUpstreamDispatcher } from "@/clients/llm-upstream-dispatcher";
import { openRouterAttributionHeaders } from "@/clients/openrouter-attribution";
import { createResponseHealingFetch } from "@/clients/openrouter-response-healing";
import config from "@/config";
import logger from "@/logging";
import { isOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { ApiError } from "@/types";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import { LlmProviderAuthRequiredError } from "@/utils/llm-provider-auth-error";

/**
 * Placeholder API key for providers that don't require authentication (vLLM, Ollama).
 * The OpenAI SDK requires a non-empty apiKey string, so we pass this sentinel value.
 */
const KEYLESS_PROVIDER_API_KEY_PLACEHOLDER = "EMPTY";

/**
 * Note: vLLM uses the @ai-sdk/openai provider (createOpenAI) since it exposes an
 * OpenAI-compatible API. Ollama uses @ai-sdk/openai-compatible instead so that
 * reasoning ("thinking") streamed in the `reasoning_content` field — which the
 * strict @ai-sdk/openai chat parser drops — surfaces as native reasoning parts.
 */

/**
 * Type representing a model that can be passed to streamText/generateText
 */
export type LLMModel = Parameters<typeof streamText>[0]["model"];

/**
 * Marks native Ollama `think` as explicitly chosen by an admin rather than
 * defaulted by ollama-ai-provider-v2. Set by `buildOllamaNativeProviderOptions`
 * as a request header; consumed and removed by `createOllamaNativeFetch` before
 * the request is sent, so neither the Archestra proxy nor Ollama ever sees it.
 *
 * It is a header rather than a field in the `options` bag because
 * ollama-ai-provider-v2 parses `providerOptions.ollama` through a closed Zod
 * object whose `options` shape lists ten fixed keys — Zod strips everything
 * else, so a marker riding in that bag never reaches the wrapper. Headers pass
 * through `combineHeaders` untouched by any schema.
 */
export const OLLAMA_THINK_EXPLICIT_HEADER = "x-archestra-ollama-think";

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
  if (provider === "openai" && isOpenAiCodexCredential(apiKey)) {
    // ChatGPT-subscription (Codex) credentials only work through the LLM proxy's
    // openai adapter, which redeems a short-lived Codex access token and targets
    // the Codex backend. This direct AI-SDK path (built-in subagents, knowledge
    // base) would send the encoded refresh token to api.openai.com as a bearer —
    // a credential leak and a guaranteed 401 — so fail closed.
    throw new ApiError(
      400,
      "ChatGPT subscription (Codex) credentials cannot be used on the direct LLM path (built-in subagents, knowledge base). Configure a standard OpenAI API key for these, or pick a different model.",
    );
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
    headers: providerHeaders(cfg),
    // Direct OpenRouter models bypass the proxy adapter, so heal the request
    // body here; the wrapper no-ops for non-healable requests.
    fetch: provider === "openrouter" ? createResponseHealingFetch() : undefined,
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
  contextIsTrusted?: boolean;
  chatApiKeyId?: string;
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
    contextIsTrusted,
    chatApiKeyId,
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
  // Only propagate the header when the caller has explicitly established that
  // context is unsafe. `undefined` means trust was not evaluated for this flow,
  // so we preserve the default trusted behavior.
  if (contextIsTrusted === false) {
    clientHeaders[UNTRUSTED_CONTEXT_HEADER] = "true";
  }
  if (baseUrl) {
    clientHeaders[PROVIDER_BASE_URL_HEADER] = baseUrl;
  }
  // Chat sends the raw provider secret to the proxy, so the proxy can't tie
  // the call to a chat_api_keys row. Forwarding the row ID here lets the
  // proxy look up per-key configuration (extraHeaders). Loopback-gated on
  // the proxy side; see CHAT_API_KEY_ID_HEADER.
  if (chatApiKeyId) {
    clientHeaders[CHAT_API_KEY_ID_HEADER] = chatApiKeyId;
    logger.info(
      { chatApiKeyId, provider },
      `[${provider}Proxy] chat attaching provider-api-key-id header`,
    );
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
  contextIsTrusted?: boolean;
}): Promise<{
  model: LLMModel;
  provider: SupportedProvider;
  apiKeySource: string;
  /**
   * True when this resolves to genuine Anthropic (vs an Anthropic-compatible
   * endpoint behind a custom base URL serving a non-Claude model). Gates
   * Anthropic-only request-body features in chat normalization, mirroring the
   * proxy's `anthropic-beta` header gating so the two can't drift.
   */
  anthropicNativeEndpoint: boolean;
  /**
   * The resolved credential row id, when a stored key was used (undefined for
   * environment-variable keys and keyless auth). This is the credential the
   * turn actually runs on — resolution can land on a personal/team/org key or
   * substitute a per-user ChatGPT-subscription credential, not just the
   * agent's own configured key.
   */
  chatApiKeyId?: string;
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
    contextIsTrusted,
  } = params;

  const {
    apiKey,
    source: apiKeySource,
    baseUrl,
    chatApiKeyId,
    authRequired,
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
  // Self-hosted providers (vLLM, both Ollama transports) never require a key,
  // and Azure/Anthropic are keyless under Entra ID / workload identity. This is
  // the same predicate `resolveProviderApiKey` uses to decide it may return an
  // undefined key, so the two must agree — a hardcoded provider list here drifts
  // and rejects keyless setups the resolver deliberately allowed.
  const isApiKeyOptional = isProviderApiKeyOptional({
    provider,
    azureEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
    anthropicWifEnabled: anthropicWorkloadIdentity.isEnabled(),
  });

  logger.info(
    {
      apiKeySource,
      provider,
      isGeminiWithVertexAi,
      isBedrockWithIamAuth,
      isApiKeyOptional,
    },
    "Using LLM provider API key",
  );

  if (
    !apiKey &&
    !isGeminiWithVertexAi &&
    !isBedrockWithIamAuth &&
    !isApiKeyOptional
  ) {
    // Per-user credentials need the acting user's own linked account; surface
    // a typed error so callers can prompt them to connect rather than showing
    // a generic "configure a key" message. Two per-user cases: resolution
    // refused a credential-level key (a ChatGPT subscription belonging to
    // someone else) and said so via authRequired, or the provider itself is
    // per-user (GitHub/Microsoft Copilot) and the user has no personal key.
    if (authRequired) {
      throw new LlmProviderAuthRequiredError(
        authRequired.provider,
        authRequired.providerLabel,
      );
    }
    if (providerRequiresPerUserCredential(provider)) {
      throw new LlmProviderAuthRequiredError(provider);
    }
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
    contextIsTrusted,
    chatApiKeyId,
  });

  const anthropicNativeEndpoint = isAnthropicNativeEndpoint({
    provider,
    model: modelName,
    baseUrl,
  });

  return {
    model,
    provider,
    apiKeySource,
    anthropicNativeEndpoint,
    chatApiKeyId,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

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
  /** Static headers always sent to the provider (e.g. OpenRouter attribution). */
  extraHeaders?: Record<string, string>;
};

/** Static provider headers (e.g. OpenRouter attribution), or undefined when none. */
function providerHeaders(
  cfg: ProviderModelConfig,
): Record<string, string> | undefined {
  return cfg.extraHeaders && Object.keys(cfg.extraHeaders).length > 0
    ? cfg.extraHeaders
    : undefined;
}

/**
 * Shared `createModel` for OpenAI-compatible providers whose models stream
 * reasoning in the `reasoning_content` delta field and expect it passed back
 * on tool-call turns. The strict @ai-sdk/openai chat converter drops reasoning
 * parts from outgoing messages and its parser drops `reasoning_content` from
 * responses; @ai-sdk/openai-compatible round-trips both.
 */
function reasoningCompatibleCreateModel(params: {
  /** Provider id — becomes the AI-SDK model provider id (`<name>.chat`). */
  name: string;
  /** Thrown when no base URL resolves (per-key override or provider default). */
  missingBaseUrlMessage: string;
  /** Substitute the placeholder key when none is set (vllm, ollama). */
  keyless?: boolean;
  /**
   * Send `response_format: json_schema` for structured outputs. Off by default:
   * the compatible provider falls back to a schema-less `json_object`, and only
   * upstreams known to honor a schema should be told otherwise.
   */
  supportsStructuredOutputs?: boolean;
}): ProviderModelConfig["createModel"] {
  const {
    name,
    missingBaseUrlMessage,
    keyless = false,
    supportsStructuredOutputs = false,
  } = params;
  return ({ apiKey, modelName, baseURL, headers, fetch }) => {
    if (!baseURL) {
      throw new ApiError(400, missingBaseUrlMessage);
    }
    return createOpenAICompatible({
      name,
      apiKey: keyless ? apiKey || KEYLESS_PROVIDER_API_KEY_PLACEHOLDER : apiKey,
      baseURL,
      headers,
      fetch,
      // @ai-sdk/openai always sends stream_options.include_usage; the compatible
      // provider only sends it when asked. Keep it on so the final usage chunk
      // still arrives and cost/usage metrics are unaffected.
      includeUsage: true,
      supportsStructuredOutputs,
    }).chatModel(modelName);
  };
}

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
      createAnthropic({
        apiKey,
        baseURL,
        headers,
        // Models that think by default return their thinking text only on
        // request — see createAnthropicThinkingDisplayFetch.
        fetch: createAnthropicThinkingDisplayFetch(fetch),
      })(modelName),
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
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) => {
      const client = createOpenAI({ apiKey, baseURL, headers, fetch });
      // "pro" reasoning models are Responses-API-only; routing them through
      // .chat() hits /chat/completions and 404s. See requiresOpenAiResponsesApi.
      return requiresOpenAiResponsesApi(modelName)
        ? client.responses(modelName)
        : client.chat(modelName);
    },
    defaultBaseUrl: config.llm.openai.baseUrl,
    apiKeyRequiredMessage:
      "OpenAI API key is required. Please configure OPENAI_API_KEY.",
  },

  openrouter: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) => {
      if (!baseURL) {
        throw new ApiError(400, "OpenRouter base URL is required.");
      }
      // OpenRouter streams thinking as a `reasoning` delta field that the
      // strict @ai-sdk/openai chat parser drops — so reasoning models' thinking
      // never reaches the UI. @ai-sdk/openai-compatible parses
      // `reasoning_content` / `reasoning` into native reasoning parts.
      return createOpenAICompatible({
        name: "openrouter",
        apiKey,
        baseURL,
        headers,
        fetch,
        // @ai-sdk/openai always sends stream_options.include_usage; the compatible
        // provider only sends it when asked. Keep it on so the final usage chunk
        // still arrives and cost/usage metrics are unaffected.
        includeUsage: true,
        // @ai-sdk/openai always sends `response_format: json_schema` for
        // structured outputs; the compatible provider defaults to a schema-less
        // `json_object` (and nothing else carries the schema to the model), which
        // breaks generateObject flows (KB reranker, dual-LLM subagents) pointed
        // at OpenRouter. OpenRouter supports json_schema; providers that can't
        // honor it ignore it, exactly as with the strict client.
        supportsStructuredOutputs: true,
      }).chatModel(modelName);
    },
    defaultBaseUrl: config.llm.openrouter.baseUrl,
    apiKeyRequiredMessage:
      "OpenRouter API key is required. Please configure ARCHESTRA_CHAT_OPENROUTER_API_KEY.",
    extraHeaders: openRouterAttributionHeaders(),
  },

  perplexity: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      // Perplexity reasoning models (sonar-reasoning-pro, sonar-deep-research)
      // stream their chain of thought as inline <think>…</think> text in
      // `content` — there is no reasoning_content field — so no provider
      // parser can surface it. The middleware extracts the tags into native
      // reasoning parts; tagless responses (sonar, sonar-pro) pass through
      // unchanged, at the accepted cost that literal <think> text in a real
      // answer is also treated as reasoning. Reasoning parts are dropped from
      // outgoing messages by the strict openai converter, which is correct
      // here: Perplexity does not accept reasoning back.
      wrapLanguageModel({
        model: createOpenAI({ apiKey, baseURL, headers, fetch }).chat(
          modelName,
        ),
        middleware: extractReasoningMiddleware({ tagName: "think" }),
      }),
    defaultBaseUrl: config.llm.perplexity.baseUrl,
    apiKeyRequiredMessage:
      "Perplexity API key is required. Please configure PERPLEXITY_API_KEY.",
  },

  "perplexity-agent": {
    // The Agent API is OpenAI-Responses-compatible, so the stock Responses
    // transport reaches it unmodified — the base URL carries the `/v1` and the
    // SDK appends `/responses`. No reasoning middleware: unlike the `sonar*`
    // chat models above, this surface has no inline <think> convention.
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createOpenAI({ apiKey, baseURL, headers, fetch }).responses(modelName),
    defaultBaseUrl: config.llm["perplexity-agent"].baseUrl,
    apiKeyRequiredMessage:
      "Perplexity Agent API key is required. Please configure ARCHESTRA_CHAT_PERPLEXITY_AGENT_API_KEY.",
  },

  zhipuai: {
    // GLM thinking mode (on by default; glm-4.7 thinks unconditionally) streams
    // its chain of thought in `reasoning_content`. Z.ai accepts only
    // `text`/`json_object` response formats, so this deliberately stays off
    // supportsStructuredOutputs: generateObject falls back to bare
    // `json_object` and the SDK validates the returned JSON against the schema.
    createModel: reasoningCompatibleCreateModel({
      name: "zhipuai",
      missingBaseUrlMessage: "Zhipu AI base URL is required.",
    }),
    defaultBaseUrl: config.llm.zhipuai.baseUrl,
    apiKeyRequiredMessage:
      "Zhipu AI API key is required. Please configure ZHIPUAI_API_KEY.",
  },

  minimax: {
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) => {
      if (!baseURL) {
        throw new ApiError(400, "MiniMax base URL is required.");
      }
      // MiniMax M-series models always think; the proxy's minimax adapter
      // mirrors the thinking text into DeepSeek-style `reasoning_content`
      // deltas. The strict @ai-sdk/openai chat converter drops reasoning parts
      // from outgoing messages and its parser drops `reasoning_content` from
      // responses; @ai-sdk/openai-compatible round-trips both.
      return createOpenAICompatible({
        name: "minimax",
        apiKey,
        baseURL,
        headers,
        fetch,
        // @ai-sdk/openai always sends stream_options.include_usage; the compatible
        // provider only sends it when asked. Keep it on so the final usage chunk
        // still arrives and cost/usage metrics are unaffected.
        includeUsage: true,
      }).chatModel(modelName);
    },
    defaultBaseUrl: config.llm.minimax.baseUrl,
    apiKeyRequiredMessage:
      "MiniMax API key is required. Please configure ARCHESTRA_CHAT_MINIMAX_API_KEY.",
  },

  deepseek: {
    // DeepSeek thinking mode 400s when the assistant's `reasoning_content` is
    // not passed back on tool-call turns.
    createModel: reasoningCompatibleCreateModel({
      name: "deepseek",
      missingBaseUrlMessage: "DeepSeek base URL is required.",
    }),
    defaultBaseUrl: config.llm.deepseek.baseUrl,
    apiKeyRequiredMessage:
      "DeepSeek API key is required. Please configure DEEPSEEK_API_KEY.",
  },

  // Another Archestra instance's OpenAI-compatible LLM proxy. Base URL is always
  // supplied per key (no global default), so direct calls rely on that override.
  archestra: {
    // The upstream Archestra streams thinking as DeepSeek-style
    // `reasoning_content` deltas and, when it fronts DeepSeek, requires them
    // passed back on tool-call turns. Failing closed on a missing base URL
    // beats the old silent fallback to api.openai.com with a virtual key.
    createModel: reasoningCompatibleCreateModel({
      name: "archestra",
      // white-label-ok: names the `archestra` upstream LLM provider a deployment connects to, not this deployment's own brand
      missingBaseUrlMessage: "Archestra base URL is required.",
      // The upstream is another Archestra model router, which forwards
      // `response_format: json_schema` the same way the strict openai client
      // sent it before. Without this the compatible client downgrades
      // generateObject flows (KB reranker, dual-LLM subagents) to a schema-less
      // `json_object`, and nothing else carries the schema to the model.
      supportsStructuredOutputs: true,
    }),
    defaultBaseUrl: config.llm.archestra.baseUrl,
    apiKeyRequiredMessage:
      // white-label-ok: names the `archestra` upstream LLM provider a deployment connects to, not this deployment's own brand
      "Archestra API key is required. Please configure an Archestra API key.",
  },

  kimi: {
    // Kimi thinking models (kimi-k3, kimi-k2.6, ...) stream reasoning in
    // `reasoning_content` and expect it passed back on tool-call turns.
    createModel: reasoningCompatibleCreateModel({
      name: "kimi",
      missingBaseUrlMessage: "Kimi base URL is required.",
    }),
    defaultBaseUrl: config.llm.kimi.baseUrl,
    apiKeyRequiredMessage:
      "Kimi API key is required. Please configure ARCHESTRA_CHAT_KIMI_API_KEY.",
  },

  "github-copilot": {
    // The model always talks to the local LLM proxy (buildProxyBaseUrl), and
    // the proxy's github-copilot adapter exchanges the GitHub OAuth token for
    // the short-lived Copilot bearer — exchanging here too would hand the
    // proxy an already-exchanged bearer it cannot exchange again.
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createOpenAI({ apiKey, baseURL, headers, fetch }).chat(modelName),
    defaultBaseUrl: config.llm["github-copilot"].baseUrl,
    apiKeyRequiredMessage:
      "GitHub Copilot requires a GitHub OAuth token. Connect your GitHub account or configure ARCHESTRA_CHAT_GITHUB_COPILOT_API_KEY.",
  },

  "microsoft-365-copilot": {
    // The model always talks to the local LLM proxy (buildProxyBaseUrl); the
    // proxy's microsoft-365-copilot adapter redeems the Entra refresh token for a
    // short-lived Graph access token and translates the OpenAI wire format to
    // the Graph Chat API — redeeming here too would hand the proxy an access
    // token it cannot redeem again.
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      createOpenAI({ apiKey, baseURL, headers, fetch }).chat(modelName),
    defaultBaseUrl: config.llm["microsoft-365-copilot"].baseUrl,
    apiKeyRequiredMessage:
      "Microsoft 365 Copilot requires a connected Microsoft account. Sign in with Microsoft when adding the provider key.",
  },

  azure: {
    createModel: ({
      apiKey,
      modelName,
      baseURL,
      headers,
      fetch: providedFetch,
    }) => {
      // The AI SDK client can't set Azure's api-version as a default query param,
      // so we wrap fetch and inject it on every request.
      const fetchWithVersion = createAzureFetchWithApiVersion({
        apiVersion: config.llm.azure.apiVersion,
        fetch: providedFetch,
      });
      const normalizedApiKey = normalizeAzureApiKey(apiKey);
      const sdkApiKey =
        normalizedApiKey ??
        (isAzureOpenAiEntraIdEnabled()
          ? KEYLESS_PROVIDER_API_KEY_PLACEHOLDER
          : undefined);
      const requestHeaders = normalizedApiKey
        ? { ...headers, "api-key": normalizedApiKey }
        : headers;

      // Azure has no usable default endpoint; without this guard createOpenAI
      // would fall back to api.openai.com and send the Azure api-key there.
      if (!baseURL) {
        throw new ApiError(400, "Azure AI Foundry base URL is required.");
      }

      // OpenAI first-party deployments stay on strict @ai-sdk/openai: its name
      // heuristic converts max_tokens → max_completion_tokens for reasoning
      // models (which reject max_tokens), and those models never stream
      // reasoning text over chat completions anyway. Foundry-hosted open models
      // (DeepSeek-R1, gpt-oss, ...) stream thinking in a `reasoning_content`
      // delta field the strict parser drops, so — like the Ollama entry — they
      // go through @ai-sdk/openai-compatible, which parses it into native
      // reasoning parts.
      if (isAzureOpenAiFirstPartyModelName(modelName)) {
        return createOpenAI({
          apiKey: sdkApiKey,
          baseURL,
          headers: requestHeaders,
          fetch: fetchWithVersion,
        }).chat(modelName);
      }

      return createOpenAICompatible({
        name: "azure",
        apiKey: sdkApiKey,
        baseURL,
        headers: requestHeaders,
        fetch: fetchWithVersion,
        // @ai-sdk/openai always sends stream_options.include_usage; the compatible
        // provider only sends it when asked. Keep it on so the final usage chunk
        // still arrives and cost/usage metrics are unaffected.
        includeUsage: true,
        // @ai-sdk/openai always sends `response_format: json_schema` for
        // structured outputs; the compatible provider defaults to a schema-less
        // `json_object` (and nothing else carries the schema to the model),
        // which breaks generateObject flows (KB reranker, dual-LLM subagents)
        // pointed at an Azure deployment. Foundry honours json_schema;
        // deployments that can't ignore it, exactly as with the strict client.
        supportsStructuredOutputs: true,
      }).chatModel(modelName);
    },
    defaultBaseUrl: config.llm.azure.baseUrl || undefined,
    apiKeyRequiredMessage:
      "Azure AI Foundry API key is required. Please configure ARCHESTRA_CHAT_AZURE_OPENAI_API_KEY.",
  },

  // --- OpenAI-compatible providers with optional API key ---

  vllm: {
    // vLLM serves DeepSeek-style reasoning models. There is no default base
    // URL (PROVIDERS_REQUIRING_BASE_URL): without the factory's guard a
    // missing URL would silently route to api.openai.com.
    createModel: reasoningCompatibleCreateModel({
      name: "vllm",
      missingBaseUrlMessage: "vLLM base URL is required.",
      keyless: true,
    }),
    defaultBaseUrl: config.llm.vllm.baseUrl,
    // No apiKeyRequiredMessage — key is optional
  },

  ollama: {
    // Ollama streams reasoning ("thinking", e.g. qwen3) in `reasoning_content`.
    createModel: reasoningCompatibleCreateModel({
      name: "ollama",
      missingBaseUrlMessage: "Ollama base URL is required.",
      keyless: true,
    }),
    defaultBaseUrl: config.llm.ollama.baseUrl,
    // No apiKeyRequiredMessage — key is optional
  },

  // Native Ollama transport: talks `/api/chat` via ollama-ai-provider-v2 so
  // num_ctx/num_predict/top_k/think are sent (the `/v1` path discards them). The
  // `/api` suffix makes the client POST to `<proxy>/ollama-native/<agent>/api/chat`.
  "ollama-native": {
    createModel: ({ modelName, baseURL, headers, fetch }) =>
      createOllama({
        baseURL,
        headers,
        // The package always emits `think`, defaulting it to false — see
        // createOllamaNativeFetch.
        fetch: createOllamaNativeFetch(fetch),
      }).chat(modelName),
    defaultBaseUrl: config.llm["ollama-native"].baseUrl,
    proxiedPathSuffix: "/api",
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
    createModel: ({ apiKey, modelName, baseURL, headers, fetch }) =>
      buildBedrockProvider({ apiKey, baseUrl: baseURL, headers, fetch })(
        modelName,
      ),
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
    // Opt-in upstream timeout dispatcher; undefined leaves undici defaults
    // untouched. See @/clients/llm-upstream-dispatcher.
    const dispatcher = getLlmUpstreamDispatcher();

    if (!dispatcher) {
      return globalThis.fetch(input, { ...init, headers });
    }

    return globalThis.fetch(input, {
      ...init,
      headers,
      dispatcher,
    } as RequestInit);
  };
}

/**
 * Wraps fetch to reconcile `think` on native Ollama `/api/chat` requests.
 *
 * ollama-ai-provider-v2 emits `think: ollamaOptions?.think ?? false`, so a caller
 * that says nothing still sends an explicit `think: false`. That is not a no-op:
 * it disables thinking, and a qwen3-class model then returns its entire chain of
 * thought as message `content` — closed by a bare `</think>` with no opening tag
 * — which renders as the assistant's answer. The OpenAI-compatible `/v1` provider
 * sends no `think` field at all, which is why it behaves correctly.
 *
 * The package offers no way to omit the field, so `buildOllamaNativeProviderOptions`
 * marks a deliberate choice with the OLLAMA_THINK_EXPLICIT_HEADER request header.
 * Here that header is consumed and removed: with it, `think` stands as
 * configured; without it, `think` is dropped so Ollama applies the model's own
 * default.
 *
 * The header is always stripped, including on the pass-through paths below — the
 * request goes to Archestra's own LLM proxy first, and an internal marker must
 * not travel any further than this wrapper.
 *
 * This wraps Archestra's own client only. Callers that POST to
 * `/v1/ollama-native/…` themselves never pass through here and keep whatever
 * `think` they sent.
 */
function createOllamaNativeFetch(
  providedFetch?: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const baseFetch = providedFetch ?? globalThis.fetch;

  return (input, init) => {
    const { hasExplicitThink, headers } = takeThinkMarkerHeader(init?.headers);
    const forwarded: RequestInit | undefined =
      init === undefined ? undefined : { ...init, headers };

    if (typeof init?.body !== "string") {
      return baseFetch(input, forwarded);
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(init.body);
      if (typeof parsed !== "object" || parsed === null) {
        return baseFetch(input, forwarded);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      // Not JSON we understand — forward verbatim rather than guessing.
      return baseFetch(input, forwarded);
    }

    if (!hasExplicitThink && "think" in body) {
      delete body.think;
    }

    // The package emits an `options` bag even when every key resolved to
    // nothing; an empty object is noise upstream.
    const options = body.options;
    if (
      typeof options === "object" &&
      options !== null &&
      Object.keys(options).length === 0
    ) {
      delete body.options;
    }

    return baseFetch(input, { ...forwarded, body: JSON.stringify(body) });
  };
}

/**
 * Wraps fetch to surface thinking text on Anthropic models that think by
 * default (see anthropicThinksByDefault).
 *
 * On those models thinking already runs — and is billed — on every request,
 * but `display` defaults to `"omitted"`, so responses carry only empty
 * thinking blocks with a signature and the UI has nothing to render.
 * Requesting `thinking: {type: "adaptive", display: "summarized"}` returns the
 * summary text. Per Anthropic's docs this changes neither billing nor prompt
 * caching: `adaptive` is those models' default, and explicitly sending a
 * default is equivalent to omitting it.
 *
 * The field is injected at the HTTP boundary because the installed
 * @ai-sdk/anthropic (3.x) has no `display` provider option — its closed Zod
 * schema strips unknown thinking keys, so no providerOptions value can carry
 * it (same constraint as OLLAMA_THINK_EXPLICIT_HEADER above).
 *
 * A request that already carries a `thinking` configuration is forwarded
 * untouched, as is any model where thinking is off by default (Opus 4.8 and
 * earlier) — enabling thinking there would add cost.
 */
function createAnthropicThinkingDisplayFetch(
  providedFetch?: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const baseFetch = providedFetch ?? globalThis.fetch;

  return (input, init) => {
    if (typeof init?.body !== "string") {
      return baseFetch(input, init);
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(init.body);
      if (typeof parsed !== "object" || parsed === null) {
        return baseFetch(input, init);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      // Not JSON we understand — forward verbatim rather than guessing.
      return baseFetch(input, init);
    }

    if (
      typeof body.model !== "string" ||
      !anthropicThinksByDefault(body.model) ||
      "thinking" in body
    ) {
      return baseFetch(input, init);
    }

    body.thinking = { type: "adaptive", display: "summarized" };
    return baseFetch(input, { ...init, body: JSON.stringify(body) });
  };
}

/**
 * Splits the internal think marker out of a request's headers, returning the
 * headers to actually send. `HeadersInit` has three shapes and the AI SDK uses
 * more than one of them, so normalize to a plain object rather than assuming.
 */
function takeThinkMarkerHeader(headers: HeadersInit | undefined): {
  hasExplicitThink: boolean;
  headers: Record<string, string>;
} {
  const out: Record<string, string> = {};
  let hasExplicitThink = false;

  const take = (key: string, value: string) => {
    if (key.toLowerCase() === OLLAMA_THINK_EXPLICIT_HEADER) {
      hasExplicitThink = true;
      return;
    }
    out[key] = value;
  };

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      take(key, value);
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) take(key, value);
  } else if (headers) {
    for (const [key, value] of Object.entries(headers)) take(key, value);
  }

  return { hasExplicitThink, headers: out };
}

/**
 * Build the proxy base URL for a provider
 */
function buildProxyBaseUrl(provider: string, agentId: string): string {
  return `http://localhost:${config.api.port}/v1/${provider}/${agentId}`;
}

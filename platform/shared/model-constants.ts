import { z } from "zod";

/**
 * Supported LLM providers
 */
export const SupportedProvidersSchema = z.enum([
  "openai",
  "gemini",
  "anthropic",
  "bedrock",
  "cohere",
  "cerebras",
  "mistral",
  "perplexity",
  "groq",
  "xai",
  "openrouter",
  "vllm",
  "ollama",
  "zhipuai",
  "deepseek",
  "minimax",
  "azure",
]);

export const SupportedProvidersDiscriminatorSchema = z.enum([
  "openai:chatCompletions",
  "openai:responses",
  "openai:embeddings",
  "gemini:generateContent",
  "gemini:embeddings",
  "anthropic:messages",
  "bedrock:converse",
  "cohere:chat",
  "cerebras:chatCompletions",
  "mistral:chatCompletions",
  "perplexity:chatCompletions",
  "groq:chatCompletions",
  "xai:chatCompletions",
  "openrouter:chatCompletions",
  "vllm:chatCompletions",
  "ollama:chatCompletions",
  "zhipuai:chatCompletions",
  "deepseek:chatCompletions",
  "minimax:chatCompletions",
  "azure:chatCompletions",
  "azure:responses",
]);

export const SupportedProviders = Object.values(SupportedProvidersSchema.enum);
export type SupportedProvider = z.infer<typeof SupportedProvidersSchema>;

/**
 * Type guard to check if a value is a valid SupportedProvider
 */
export function isSupportedProvider(
  value: unknown,
): value is SupportedProvider {
  return SupportedProvidersSchema.safeParse(value).success;
}

export type SupportedProviderDiscriminator = z.infer<
  typeof SupportedProvidersDiscriminatorSchema
>;

export const providerDisplayNames: Record<SupportedProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  bedrock: "AWS Bedrock",
  gemini: "Gemini",
  cohere: "Cohere",
  cerebras: "Cerebras",
  mistral: "Mistral AI",
  perplexity: "Perplexity AI",
  groq: "Groq",
  xai: "xAI",
  openrouter: "OpenRouter",
  vllm: "vLLM",
  ollama: "Ollama",
  zhipuai: "Zhipu AI",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  azure: "Azure AI Foundry",
};

/**
 * Providers where an API key can be omitted when creating a provider key.
 * Self-hosted providers are always optional. Azure is optional only when
 * Microsoft Entra ID authentication is enabled in the backend environment.
 */
const PROVIDERS_WITH_OPTIONAL_API_KEY = new Set<SupportedProvider>([
  "ollama",
  "vllm",
]);

export function isProviderApiKeyOptional(params: {
  provider: SupportedProvider;
  azureEntraIdEnabled?: boolean;
}): boolean {
  return (
    PROVIDERS_WITH_OPTIONAL_API_KEY.has(params.provider) ||
    (params.provider === "azure" && params.azureEntraIdEnabled === true)
  );
}

export function getProvidersWithOptionalApiKey(params?: {
  azureEntraIdEnabled?: boolean;
}): SupportedProvider[] {
  const providers = [...PROVIDERS_WITH_OPTIONAL_API_KEY];
  if (params?.azureEntraIdEnabled === true) {
    providers.push("azure");
  }
  return providers;
}

/**
 * Perplexity model definitions — single source of truth.
 * Perplexity has no /models endpoint, so models are maintained here.
 * @see https://ai-sdk.dev/providers/ai-sdk-providers/perplexity#model-capabilities
 */
export const PERPLEXITY_MODELS = [
  { id: "sonar-pro", displayName: "Sonar Pro" },
  { id: "sonar", displayName: "Sonar" },
  { id: "sonar-reasoning-pro", displayName: "Sonar Reasoning Pro" },
  { id: "sonar-reasoning", displayName: "Sonar Reasoning" },
  { id: "sonar-deep-research", displayName: "Sonar Deep Research" },
] as const;

/**
 * MiniMax model definitions — single source of truth.
 * MiniMax does not provide a /v1/models endpoint, so models are maintained here.
 * @see https://platform.minimax.io/docs/guides/models-intro
 */
export const MINIMAX_MODELS = [
  { id: "MiniMax-M2.7", displayName: "MiniMax-M2.7" },
  { id: "MiniMax-M2.7-highspeed", displayName: "MiniMax-M2.7-highspeed" },
  { id: "MiniMax-M2.5", displayName: "MiniMax-M2.5" },
  { id: "MiniMax-M2.5-highspeed", displayName: "MiniMax-M2.5-highspeed" },
] as const;

/**
 * Default provider base URLs.
 * Used as placeholder hints in the UI and as fallback values when no per-key base URL is configured.
 */
export const DEFAULT_PROVIDER_BASE_URLS: Record<SupportedProvider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  bedrock: "",
  cohere: "https://api.cohere.ai",
  cerebras: "https://api.cerebras.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  perplexity: "https://api.perplexity.ai",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  vllm: "",
  ollama: "http://localhost:11434/v1",
  zhipuai: "https://api.z.ai/api/paas/v4",
  deepseek: "https://api.deepseek.com",
  minimax: "https://api.minimax.io/v1",
  azure: "https://<resource>.openai.azure.com/openai",
};

/**
 * OpenRouter's built-in "Auto Router" — routes each request to a model OpenRouter
 * picks dynamically, billed at that model's rate. Not free.
 */
export const OPENROUTER_AUTO_MODEL_ID = "openrouter/auto";

/**
 * OpenRouter's built-in "Free Models Router" — routes each request to a free
 * model OpenRouter picks, filtering for the features the request needs. Always
 * zero-cost; used as the auto-default for fresh OpenRouter organizations.
 */
export const OPENROUTER_FREE_MODEL_ID = "openrouter/free";

/**
 * Prefix of OpenRouter "latest" alias ids (e.g. `~anthropic/claude-sonnet-latest`)
 * that always redirect to the newest model in a family.
 */
export const OPENROUTER_LATEST_ALIAS_PREFIX = "~";

/**
 * Pattern-based model markers per provider.
 * Patterns are substrings that model IDs must contain (case-insensitive).
 * Used to identify "fastest" (lightweight, low latency) and "best" (highest quality) models.
 *
 * IMPORTANT: Patterns are checked in array order (first match wins).
 * More specific patterns should come before general ones.
 */
export const MODEL_MARKER_PATTERNS: Record<
  SupportedProvider,
  {
    fastest: string[];
    best: string[];
  }
> = {
  anthropic: {
    fastest: ["haiku-4-5-20251001", "haiku-4-5"],
    best: ["opus-4-7"],
  },
  openai: {
    fastest: ["gpt-5.4-nano", "gpt-5.4-mini"],
    best: ["gpt-5.5-pro", "gpt-5.5"],
  },
  gemini: {
    fastest: ["gemini-3.1-flash-lite", "gemini-3.5-flash"],
    best: ["gemini-3.1-pro-preview"],
  },
  cerebras: {
    fastest: ["llama3.1-8b"],
    best: ["zai-glm-4.7"],
  },
  cohere: {
    fastest: ["command-r7b-12-2024"],
    best: ["command-a-plus-05-2026"],
  },
  mistral: {
    fastest: ["mistral-small-2603"],
    best: ["mistral-medium-2604"],
  },
  perplexity: {
    fastest: ["sonar"],
    best: ["sonar-deep-research", "sonar-reasoning-pro", "sonar-pro"],
  },
  groq: {
    fastest: ["openai/gpt-oss-20b", "llama-3.1-8b-instant"],
    best: ["openai/gpt-oss-120b"],
  },
  xai: {
    fastest: ["grok-4.3"],
    best: ["grok-4.3"],
  },
  openrouter: {
    fastest: ["openrouter/auto"],
    best: [
      "anthropic/claude-opus-4.7",
      "openai/gpt-5.5-pro",
      "openai/gpt-5.5",
      "google/gemini-3.1-pro-preview",
      "x-ai/grok-4.3",
      "deepseek/deepseek-v4-pro",
    ],
  },
  ollama: {
    fastest: ["gpt-oss:20b", "llama3.2:3b", "phi4-mini"],
    best: ["gpt-oss:120b", "llama4:maverick", "llama4:scout", "qwen3:235b"],
  },
  vllm: {
    fastest: ["gpt-oss-20b", "llama-3.2-3b", "phi-4-mini"],
    best: ["gpt-oss-120b", "llama-4-maverick", "llama-4-scout", "qwen3-235b"],
  },
  zhipuai: {
    fastest: ["glm-4.7-flash"],
    best: ["glm-5.1"],
  },
  deepseek: {
    fastest: ["deepseek-v4-flash"],
    best: ["deepseek-v4-pro"],
  },
  minimax: {
    fastest: ["minimax-m2.7-highspeed"],
    best: ["minimax-m2.7"],
  },
  azure: {
    fastest: ["gpt-5.4-nano", "gpt-5.4-mini"],
    best: ["gpt-5.5"],
  },
  bedrock: {
    fastest: ["amazon.nova-2-lite-v1:0", "amazon.nova-lite-v1:0"],
    best: ["anthropic.claude-opus-4-7"],
  },
};

/**
 * Fast models for each provider, used as fallback for title generation and other quick operations.
 * These are optimized for speed and cost rather than capability.
 *
 * Primary resolution uses LlmProviderApiKeyModelLinkModel.getFastestModel() from the database.
 * This map serves as a fallback when no database result is available.
 */
export const FAST_MODELS: Record<SupportedProvider, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-5.4-mini",
  openrouter: "openrouter/auto",
  gemini: "gemini-3.5-flash",
  cerebras: "llama3.1-8b", // cerebras focuses on speed, all their models are fast
  cohere: "command-r7b-12-2024", // cohere's fast model
  vllm: "default", // vLLM uses whatever model is deployed
  ollama: "llama3.2", // common fast model for Ollama
  zhipuai: "glm-4.7-flash", // zhipu's fast model
  minimax: "MiniMax-M2.7-highspeed", // minimax's fastest model
  deepseek: "deepseek-v4-flash", // deepSeek's fast model
  bedrock: "amazon.nova-2-lite-v1:0", // bedrock's fast model
  mistral: "mistral-small-2603", // mistral's fast model
  perplexity: "sonar", // perplexity's fast model
  groq: "llama-3.1-8b-instant", // groq's fast model
  xai: "grok-4.3", // xAI's fast model
  azure: "gpt-5.4-mini",
};

/**
 * Default model for each provider when no synced "best" model is available.
 * Using Record<SupportedProvider, string> ensures a compile-time error when a new provider is added.
 */
export const DEFAULT_MODELS: Record<SupportedProvider, string> = {
  anthropic: "claude-opus-4-7",
  openai: "gpt-5.5",
  openrouter: "openrouter/auto",
  gemini: "gemini-3.1-pro-preview",
  cohere: "command-a-plus-05-2026",
  groq: "openai/gpt-oss-120b",
  xai: "grok-4.3",
  ollama: "llama3.2",
  vllm: "default",
  cerebras: "zai-glm-4.7",
  mistral: "mistral-medium-2604",
  perplexity: "sonar-pro",
  zhipuai: "glm-5.1",
  deepseek: "deepseek-v4-pro",
  bedrock: "anthropic.claude-opus-4-7",
  minimax: "MiniMax-M2.7",
  azure: "gpt-5.5",
};
/**
 * Maps models.dev provider IDs to Archestra provider names.
 * This is the single source of truth for all synchronization logic.
 *
 * Providers mapped to `null` are explicitly skipped during models.dev sync.
 * This includes providers that use custom authentication flows (e.g., Bedrock
 * uses SigV4, Azure uses Azure-specific auth) and are therefore managed
 * through their own dedicated sync pathways.
 */
export const MODELS_DEV_PROVIDER_MAP: Record<string, SupportedProvider | null> =
  {
    openai: "openai",
    openrouter: "openrouter",
    anthropic: "anthropic",
    google: "gemini",
    "google-vertex": "gemini",
    cohere: "cohere",
    cerebras: "cerebras",
    mistral: "mistral",
    minimax: "minimax",
    // These providers use OpenAI-compatible API in Archestra
    llama: "openai",
    deepseek: "deepseek",
    groq: "groq",
    "fireworks-ai": "openai",
    togetherai: "openai",
    xai: "xai",
    // Explicitly unsupported providers (return null to skip during models.dev sync)
    // Bedrock and Azure have dedicated auth flows and are not synced via models.dev
    "amazon-bedrock": null,
    azure: null,
    perplexity: null,
    nvidia: null,
  };

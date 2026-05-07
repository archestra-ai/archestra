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
 * @see https://www.minimaxi.com/en/news
 */
export const MINIMAX_MODELS = [
  { id: "MiniMax-M2", displayName: "MiniMax-M2" },
  { id: "MiniMax-M2.1", displayName: "MiniMax-M2.1" },
  { id: "MiniMax-M2.1-lightning", displayName: "MiniMax-M2.1-lightning" },
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
  azure: "https://<resource>.openai.azure.com/openai/deployments/<deployment>",
};

/**
 * Pattern-based model markers per provider.
 * Patterns are substrings that model IDs must contain (case-insensitive).
 * Used to identify "fastest" (lightweight, low latency) and "best" (highest quality) models.
 *
 * IMPORTANT: Patterns are checked in array order (first match wins).
 * More specific patterns should come before general ones.
 *
 * Note: For OpenAI "best", we use "4o-2" to match "gpt-4o-2024..." but NOT "gpt-4o-mini-...".
 */
export const MODEL_MARKER_PATTERNS: Record<
  SupportedProvider,
  {
    fastest: string[];
    best: string[];
  }
> = {
  anthropic: {
    fastest: ["haiku-4", "haiku"],
    best: ["opus-4-6", "opus-4-5", "opus-4", "opus", "sonnet"],
  },
  openai: {
    fastest: ["gpt-4o-mini", "gpt-3.5"],
    best: [
      "gpt-5.4",
      "gpt-5.3",
      "gpt-5.2",
      "gpt-5",
      "o3",
      "o1",
      "4o-2",
      "gpt-4-turbo",
    ],
  },
  gemini: {
    fastest: ["flash"],
    best: ["pro", "ultra"],
  },
  cerebras: {
    fastest: ["llama-3.3-70b"],
    best: ["llama-3.3-70b"],
  },
  cohere: {
    fastest: ["command-light"],
    best: ["command-r-plus", "command-r"],
  },
  mistral: {
    fastest: ["mistral-small", "ministral"],
    best: ["mistral-large"],
  },
  perplexity: {
    fastest: ["sonar"],
    best: ["sonar-pro", "sonar-reasoning-pro", "sonar-reasoning"],
  },
  groq: {
    fastest: ["llama-3.1-8b", "gemma2-9b"],
    best: ["llama-3.3-70b", "llama-3.1-70b"],
  },
  xai: {
    fastest: ["fast", "grok-code"],
    best: ["grok-4"],
  },
  openrouter: {
    fastest: ["openrouter/auto"],
    best: [
      "openai/gpt-4.1",
      "openai/gpt-4o",
      "anthropic/claude-3.7",
      "anthropic/claude-3-opus",
    ],
  },
  ollama: {
    fastest: ["llama3.2", "phi"],
    best: ["llama3.1", "mixtral"],
  },
  vllm: {
    fastest: ["llama3.2", "phi"],
    best: ["llama3.1", "mixtral"],
  },
  zhipuai: {
    fastest: ["glm-4-flash", "glm-flash"],
    best: ["glm-4-plus", "glm-4"],
  },
  deepseek: {
    fastest: ["deepseek-chat"],
    best: ["deepseek-reasoner"],
  },
  minimax: {
    fastest: ["minimax-m2.5-highspeed", "minimax-m2.1-lightning"],
    best: ["minimax-m2.5", "minimax-m2.1", "minimax-m2"],
  },
  azure: {
    fastest: ["gpt-4o-mini"],
    best: ["gpt-4o", "o3"],
  },
  bedrock: {
    fastest: ["nova-lite", "nova-micro", "haiku"],
    best: ["nova-pro", "sonnet", "opus"],
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
  openai: "gpt-4o-mini",
  openrouter: "openrouter/auto",
  gemini: "gemini-2.0-flash-001",
  cerebras: "llama-3.3-70b", // Cerebras focuses on speed, all their models are fast
  cohere: "command-light", // Cohere's fast model
  vllm: "default", // vLLM uses whatever model is deployed
  ollama: "llama3.2", // Common fast model for Ollama
  zhipuai: "glm-4-flash", // Zhipu's fast model
  minimax: "MiniMax-M2.5-highspeed", // MiniMax's fastest model
  deepseek: "deepseek-chat", // DeepSeek's fast model
  bedrock: "amazon.nova-lite-v1:0", // Bedrock's fast model, available in all regions for on-demand inference
  mistral: "mistral-small-latest", // Mistral's fast model
  perplexity: "sonar", // Perplexity's fast model
  groq: "llama-3.1-8b-instant", // Groq's fast model
  xai: "grok-code-fast-1", // xAI's fast model
  azure: "gpt-4o-mini",
};

/**
 * Default model for each provider when no synced "best" model is available.
 * Using Record<SupportedProvider, string> ensures a compile-time error when a new provider is added.
 */
export const DEFAULT_MODELS: Record<SupportedProvider, string> = {
  anthropic: "claude-opus-4-6-20250918",
  openai: "gpt-5.4",
  openrouter: "openrouter/auto",
  gemini: "gemini-2.5-pro",
  cohere: "command-r-08-2024",
  groq: "llama-3.1-8b-instant",
  xai: "grok-4",
  ollama: "llama3.2",
  vllm: "default",
  cerebras: "llama-4-scout-17b-16e-instruct",
  mistral: "mistral-large-latest",
  perplexity: "sonar-pro",
  zhipuai: "glm-4-plus",
  deepseek: "deepseek-chat",
  bedrock: "anthropic.claude-opus-4-1-20250805-v1:0",
  minimax: "MiniMax-M2.5",
  azure: "gpt-4o",
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

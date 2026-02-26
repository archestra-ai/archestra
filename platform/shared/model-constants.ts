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
  "vllm",
  "ollama",
  "zhipuai",
  "deepseek",
  "minimax",
]);

export const SupportedProvidersDiscriminatorSchema = z.enum([
  "openai:chatCompletions",
  "gemini:generateContent",
  "anthropic:messages",
  "bedrock:converse",
  "cohere:chat",
  "cerebras:chatCompletions",
  "mistral:chatCompletions",
  "perplexity:chatCompletions",
  "groq:chatCompletions",
  "vllm:chatCompletions",
  "ollama:chatCompletions",
  "zhipuai:chatCompletions",
  "deepseek:chatCompletions",
  "minimax:chatCompletions",
]);

export const SupportedProviders = Object.values(SupportedProvidersSchema.enum);
export type SupportedProvider = z.infer<typeof SupportedProvidersSchema>;
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
  vllm: "vLLM",
  ollama: "Ollama",
  zhipuai: "Zhipu AI",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
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
  vllm: "",
  ollama: "http://localhost:11434/v1",
  zhipuai: "https://api.z.ai/api/paas/v4",
  deepseek: "https://api.deepseek.com",
  minimax: "https://api.minimax.io/v1",
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
    best: ["opus", "sonnet"],
  },
  openai: {
    fastest: ["gpt-4o-mini", "gpt-3.5"],
    // "4o-2" matches "gpt-4o-2024..." but not "gpt-4o-mini-..."
    best: ["o1", "o3", "4o-2", "gpt-4-turbo"],
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
  bedrock: {
    fastest: ["nova-lite", "nova-micro", "haiku"],
    best: ["nova-pro", "sonnet", "opus"],
  },
};

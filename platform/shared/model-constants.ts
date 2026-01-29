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
  "vllm",
  "ollama",
  "zhipuai",
]);

export const SupportedProvidersDiscriminatorSchema = z.enum([
  "openai:chatCompletions",
  "gemini:generateContent",
  "anthropic:messages",
  "bedrock:converse",
  "cohere:chat",
  "cerebras:chatCompletions",
  "mistral:chatCompletions",
  "vllm:chatCompletions",
  "ollama:chatCompletions",
  "zhipuai:chatCompletions",
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
  vllm: "vLLM",
  ollama: "Ollama",
  zhipuai: "Zhipu AI",
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
    fastest: ["haiku"],
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
  bedrock: {
    fastest: ["nova-lite", "nova-micro", "haiku"],
    best: ["nova-pro", "sonnet", "opus"],
  },
};

import { z } from "zod";

/**
 * Supported LLM providers
 */
export const SupportedProvidersSchema = z.enum([
  "openai",
  "gemini",
  "anthropic",
  "cerebras",
  "vllm",
  "ollama",
]);

export const SupportedProvidersDiscriminatorSchema = z.enum([
  "openai:chatCompletions",
  "gemini:generateContent",
  "anthropic:messages",
  "cerebras:chatCompletions",
  "vllm:chatCompletions",
  "ollama:chatCompletions",
]);

export const SupportedProviders = Object.values(SupportedProvidersSchema.enum);
export type SupportedProvider = z.infer<typeof SupportedProvidersSchema>;
export type SupportedProviderDiscriminator = z.infer<
  typeof SupportedProvidersDiscriminatorSchema
>;

export const providerDisplayNames: Record<SupportedProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  cerebras: "Cerebras",
  vllm: "vLLM",
  ollama: "Ollama",
};

/**
 * Model capabilities that can be displayed in the UI
 */
export const ModelCapabilitiesSchema = z.enum([
  "reasoning",
  "vision",
  "audio",
  "tools",
  "json_mode",
  "streaming",
  "high_context",
  "code",
]);

export type ModelCapability = z.infer<typeof ModelCapabilitiesSchema>;
export const ModelCapabilities = Object.values(ModelCapabilitiesSchema.enum);

/**
 * Display information for each capability
 */
export const capabilityDisplayInfo: Record<
  ModelCapability,
  { label: string; description: string }
> = {
  reasoning: {
    label: "Reasoning",
    description: "Advanced reasoning and chain-of-thought capabilities",
  },
  vision: {
    label: "Vision",
    description: "Can analyze and understand images",
  },
  audio: {
    label: "Audio",
    description: "Can process audio input/output",
  },
  tools: {
    label: "Tools",
    description: "Supports function calling and tool use",
  },
  json_mode: {
    label: "JSON",
    description: "Structured JSON output mode",
  },
  streaming: {
    label: "Stream",
    description: "Supports streaming responses",
  },
  high_context: {
    label: "Long Context",
    description: "Supports large context windows (100k+ tokens)",
  },
  code: {
    label: "Code",
    description: "Optimized for code generation and analysis",
  },
};

/**
 * Known model capabilities mapping
 * Maps model ID patterns to their capabilities
 */
export const modelCapabilitiesMap: Record<string, ModelCapability[]> = {
  // OpenAI models
  "gpt-4o": ["vision", "tools", "json_mode", "streaming", "code"],
  "gpt-4o-mini": ["vision", "tools", "json_mode", "streaming", "code"],
  "gpt-4-turbo": ["vision", "tools", "json_mode", "streaming", "high_context"],
  "gpt-4": ["tools", "json_mode", "streaming"],
  "gpt-3.5-turbo": ["tools", "json_mode", "streaming"],
  "o1": ["reasoning", "vision", "tools", "high_context", "code"],
  "o1-mini": ["reasoning", "tools", "code"],
  "o1-preview": ["reasoning", "high_context", "code"],
  "o3-mini": ["reasoning", "tools", "code"],

  // Anthropic models
  "claude-3-5-sonnet": ["vision", "tools", "json_mode", "streaming", "code"],
  "claude-3-5-haiku": ["vision", "tools", "json_mode", "streaming", "code"],
  "claude-3-opus": [
    "vision",
    "tools",
    "json_mode",
    "streaming",
    "high_context",
    "code",
  ],
  "claude-3-sonnet": ["vision", "tools", "json_mode", "streaming", "code"],
  "claude-3-haiku": ["vision", "tools", "json_mode", "streaming"],
  "claude-sonnet-4": [
    "reasoning",
    "vision",
    "tools",
    "json_mode",
    "streaming",
    "code",
  ],
  "claude-opus-4": [
    "reasoning",
    "vision",
    "tools",
    "json_mode",
    "streaming",
    "high_context",
    "code",
  ],

  // Gemini models
  "gemini-2.0-flash": [
    "vision",
    "audio",
    "tools",
    "json_mode",
    "streaming",
    "code",
  ],
  "gemini-2.0-pro": [
    "reasoning",
    "vision",
    "audio",
    "tools",
    "json_mode",
    "streaming",
    "high_context",
    "code",
  ],
  "gemini-1.5-flash": ["vision", "tools", "json_mode", "streaming"],
  "gemini-1.5-pro": [
    "vision",
    "tools",
    "json_mode",
    "streaming",
    "high_context",
  ],
  "gemini-exp": [
    "reasoning",
    "vision",
    "tools",
    "json_mode",
    "streaming",
    "high_context",
  ],

  // Cerebras models (fast inference, limited capabilities)
  "llama-3.3-70b": ["tools", "streaming", "code"],
  "qwen-2.5-coder": ["tools", "streaming", "code"],
};

/**
 * Get capabilities for a model by matching against known patterns
 * @param modelId - The model ID to look up
 * @returns Array of capabilities, or empty array if unknown
 */
export function getModelCapabilities(modelId: string): ModelCapability[] {
  const lowerModelId = modelId.toLowerCase();

  // Try exact match first
  if (modelCapabilitiesMap[modelId]) {
    return modelCapabilitiesMap[modelId];
  }

  // Try prefix match (e.g., "gpt-4o-2024-08-06" matches "gpt-4o")
  for (const [pattern, capabilities] of Object.entries(modelCapabilitiesMap)) {
    if (lowerModelId.startsWith(pattern.toLowerCase())) {
      return capabilities;
    }
  }

  // Try contains match for versioned models
  for (const [pattern, capabilities] of Object.entries(modelCapabilitiesMap)) {
    if (lowerModelId.includes(pattern.toLowerCase())) {
      return capabilities;
    }
  }

  // Default: return empty array for unknown models
  return [];
}

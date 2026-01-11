import {
  type ModelCapabilities,
  type ModelCapability,
  ModelCapabilitySchema,
} from "@shared";
import logger from "@/logging";

export interface ModelCapabilityPatterns {
  patterns: {
    capability: ModelCapability;
    pattern: RegExp;
    priority?: number;
  }[];
}

const OPENAI_PATTERNS: ModelCapabilityPatterns = {
  patterns: [
    { capability: "chat", pattern: /^gpt-/ },
    { capability: "vision", pattern: /^gpt-4o/, priority: 1 },
    { capability: "vision", pattern: /^gpt-4-vision/, priority: 1 },
    { capability: "vision", pattern: /-vision/, priority: 2 },
    { capability: "reasoning", pattern: /^o1/, priority: 1 },
    { capability: "reasoning", pattern: /^gpt-4o-reason/, priority: 2 },
    { capability: "function-calling", pattern: /^gpt-(3\.5|4)/ },
    { capability: "json-mode", pattern: /-json/ },
    { capability: "context-window", pattern: /-(128k|256k|1m)/ },
    { capability: "context-window", pattern: /-large-context/ },
    { capability: "audio", pattern: /whisper/, priority: 1 },
    { capability: "audio", pattern: /-audio/, priority: 2 },
    { capability: "streaming", pattern: /^gpt-/ },
    { capability: "system-prompt", pattern: /^gpt-(3\.5|4)/ },
    { capability: "fine-tuned", pattern: /-(\d{4}|ft)/ },
  ],
};

const ANTHROPIC_PATTERNS: ModelCapabilityPatterns = {
  patterns: [
    { capability: "chat", pattern: /^claude-/ },
    { capability: "vision", pattern: /^claude-3\.5/, priority: 1 },
    { capability: "vision", pattern: /^claude-3/, priority: 2 },
    { capability: "reasoning", pattern: /^claude-3-opus/, priority: 1 },
    { capability: "reasoning", pattern: /^claude-3\.5-sonnet/, priority: 2 },
    { capability: "function-calling", pattern: /^claude-(3|3\.5)/ },
    { capability: "context-window", pattern: /-(200k)/ },
    { capability: "audio", pattern: /-audio/ },
    { capability: "streaming", pattern: /^claude-/ },
    { capability: "system-prompt", pattern: /^claude-(3|3\.5)/ },
    { capability: "fine-tuned", pattern: /-(custom|ft)/ },
  ],
};

const GEMINI_PATTERNS: ModelCapabilityPatterns = {
  patterns: [
    { capability: "chat", pattern: /^gemini-/ },
    { capability: "chat", pattern: /^models\/gemini-/ },
    { capability: "vision", pattern: /^gemini-1\.5/, priority: 1 },
    { capability: "vision", pattern: /^gemini-2\.0/, priority: 1 },
    { capability: "vision", pattern: /-vision/, priority: 2 },
    { capability: "multimodal", pattern: /^gemini-/ },
    { capability: "reasoning", pattern: /-pro/, priority: 1 },
    { capability: "reasoning", pattern: /-ultra/, priority: 1 },
    { capability: "function-calling", pattern: /^gemini-(1\.5|2\.0)/ },
    { capability: "context-window", pattern: /-(1m|2m)/ },
    { capability: "audio", pattern: /-audio/ },
    { capability: "streaming", pattern: /^gemini-/ },
    { capability: "system-prompt", pattern: /^gemini-(1\.5|2\.0)/ },
  ],
};

const MISTRAL_PATTERNS: ModelCapabilityPatterns = {
  patterns: [
    { capability: "chat", pattern: /^mistral-/ },
    { capability: "vision", pattern: /-vision/ },
    { capability: "function-calling", pattern: /^mistral-(large|small)/ },
    { capability: "context-window", pattern: /-(32k|128k)/ },
    { capability: "streaming", pattern: /^mistral-/ },
    { capability: "system-prompt", pattern: /^mistral-(large|small)/ },
  ],
};

const COHERE_PATTERNS: ModelCapabilityPatterns = {
  patterns: [
    { capability: "chat", pattern: /^command-/ },
    { capability: "function-calling", pattern: /^command-r/ },
    { capability: "context-window", pattern: /-(128k)/ },
    { capability: "streaming", pattern: /^command-/ },
  ],
};

const META_PATTERNS: ModelCapabilityPatterns = {
  patterns: [
    { capability: "chat", pattern: /^llama-/ },
    { capability: "chat", pattern: /^meta-llama-/ },
    { capability: "code", pattern: /-code-/ },
    { capability: "context-window", pattern: /-(100k)/ },
    { capability: "streaming", pattern: /^llama-/ },
  ],
};

const VLLM_PATTERNS: ModelCapabilityPatterns = {
  patterns: [
    { capability: "chat", pattern: /^.*$/ },
    { capability: "vision", pattern: /-vision/ },
    { capability: "code", pattern: /-code-/ },
    { capability: "streaming", pattern: /^.*$/ },
  ],
};

const OLLAMA_PATTERNS: ModelCapabilityPatterns = {
  patterns: [
    { capability: "chat", pattern: /^.*$/ },
    { capability: "vision", pattern: /-vision/ },
    { capability: "vision", pattern: /llava/ },
    { capability: "code", pattern: /-code-/ },
    { capability: "code", pattern: /codellama/ },
    { capability: "streaming", pattern: /^.*$/ },
  ],
};

const CAPABILITY_PATTERNS: Record<string, ModelCapabilityPatterns> = {
  openai: OPENAI_PATTERNS,
  anthropic: ANTHROPIC_PATTERNS,
  gemini: GEMINI_PATTERNS,
  mistral: MISTRAL_PATTERNS,
  cohere: COHERE_PATTERNS,
  meta: META_PATTERNS,
  vllm: VLLM_PATTERNS,
  ollama: OLLAMA_PATTERNS,
};

export interface CapabilityMetadata {
  maxTokens?: number;
  supportsImages?: boolean;
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  supportsStreaming?: boolean;
  supportsFunctionCalling?: boolean;
  supportsJsonMode?: boolean;
  hasReasoning?: boolean;
}

export function detectModelCapabilities(
  modelId: string,
  provider: string,
): ModelCapabilities {
  const patterns = CAPABILITY_PATTERNS[provider];
  if (!patterns) {
    logger.debug(
      { modelId, provider },
      "No capability patterns found for provider",
    );
    return { capabilities: [], metadata: {} };
  }

  const capabilities: Set<ModelCapability> = new Set();
  const metadata: CapabilityMetadata = {};

  const matchedPatterns = patterns.patterns
    .filter((pattern) => pattern.pattern.test(modelId))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const pattern of matchedPatterns) {
    capabilities.add(pattern.capability);
  }

  if (capabilities.has("vision")) metadata.supportsImages = true;
  if (capabilities.has("audio")) metadata.supportsAudio = true;
  if (capabilities.has("streaming")) metadata.supportsStreaming = true;
  if (capabilities.has("function-calling"))
    metadata.supportsFunctionCalling = true;
  if (capabilities.has("json-mode")) metadata.supportsJsonMode = true;
  if (capabilities.has("reasoning")) metadata.hasReasoning = true;

  const contextMatch = modelId.match(/-(\d+)k/);
  if (contextMatch) {
    const contextK = parseInt(contextMatch[1], 10);
    if (contextK > 100) {
      metadata.maxTokens = contextK * 1000;
    }
  }

  return {
    capabilities: Array.from(capabilities),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

export function validateCapabilities(
  capabilities: ModelCapabilities,
): ModelCapabilities {
  try {
    const validatedCapabilities = capabilities.capabilities.filter(
      (capability) => ModelCapabilitySchema.safeParse(capability).success,
    );

    return {
      ...capabilities,
      capabilities: validatedCapabilities,
    };
  } catch (error) {
    logger.warn(
      { error, capabilities },
      "Failed to validate capabilities, returning empty set",
    );
    return { capabilities: [], metadata: {} };
  }
}

export function getModelCapabilities(
  modelId: string,
  provider: string,
): ModelCapabilities {
  const detected = detectModelCapabilities(modelId, provider);
  return validateCapabilities(detected);
}

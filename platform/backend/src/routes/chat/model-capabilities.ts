import {
  type ModelCapabilities,
  type ModelCapability,
  ModelCapabilitySchema,
} from "@shared";
import logger from "@/logging";

interface OpenRouterModelArchitecture {
  modality: string;
  input_modalities: string[];
  output_modalities: string[];
  tokenizer: string;
  instruct_type: string | null;
}

export interface OpenRouterModel {
  id: string;
  canonical_slug?: string;
  hugging_face_id?: string;
  name: string;
  created: number;
  description?: string;
  context_length: number;
  architecture: OpenRouterModelArchitecture;
  pricing?: {
    prompt: string;
    completion: string;
    image?: string;
  };
  top_provider?: {
    context_length: number;
    max_completion_tokens: number;
    is_moderated: boolean;
  };
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

export interface CapabilityMetadata {
  maxTokens?: number;
  contextLength?: number;
  modelName?: string;
  maxCompletionTokens?: number;
  isModerated?: boolean;
  supportsImages?: boolean;
  supportsAudio?: boolean;
  supportsVideo?: boolean;
  supportsStreaming?: boolean;
  supportsFunctionCalling?: boolean;
  supportsJsonMode?: boolean;
  hasReasoning?: boolean;
  canGenerateImages?: boolean;
}

const MODELS_CACHE = new Map<string, OpenRouterModel>();
let ALL_MODELS_CACHE: OpenRouterModel[] | null = null;
let LAST_FETCH_TIME = 0;
const CACHE_DURATION = 30 * 60 * 1000;
const MAX_CACHE_SIZE = 2000;
const FETCH_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

function parseCapabilitiesFromArchitecture(
  architecture: OpenRouterModelArchitecture,
  capabilities: Set<ModelCapability>,
  metadata: CapabilityMetadata,
): void {
  const { input_modalities = [], output_modalities = [] } = architecture;
  const modality = architecture.modality?.toLowerCase() ?? "";

  if (
    input_modalities.includes("image") ||
    input_modalities.includes("video")
  ) {
    capabilities.add("vision");
    metadata.supportsImages = true;
  }

  if (input_modalities.includes("video")) {
    metadata.supportsVideo = true;
  }

  if (input_modalities.includes("audio")) {
    capabilities.add("audio");
    metadata.supportsAudio = true;
  }

  if (input_modalities.length > 1) {
    capabilities.add("multimodal");
  }

  if (modality.includes("image") && modality.includes("text")) {
    capabilities.add("vision");
    capabilities.add("multimodal");
    metadata.supportsImages = true;
  }

  if (modality.includes("audio")) {
    capabilities.add("audio");
    metadata.supportsAudio = true;
  }

  if (modality.includes("->image") || modality.includes("-> image")) {
    capabilities.add("image-gen");
    metadata.canGenerateImages = true;
  }

  if (input_modalities.includes("text") && output_modalities.includes("text")) {
    capabilities.add("chat");
  }
}

function pruneCacheIfNeeded(): void {
  if (MODELS_CACHE.size > MAX_CACHE_SIZE) {
    const entriesToDelete = MODELS_CACHE.size - MAX_CACHE_SIZE;
    const iterator = MODELS_CACHE.keys();

    for (let i = 0; i < entriesToDelete; i++) {
      const key = iterator.next().value;
      if (key) {
        MODELS_CACHE.delete(key);
      }
    }

    logger.debug(
      { remainingCacheSize: MODELS_CACHE.size },
      "Pruned OpenRouter cache",
    );
  }
}

async function fetchWithRetry(
  url: string,
  retries: number = MAX_RETRIES,
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(url, { signal: controller.signal });

      clearTimeout(timeoutId);

      if (response.ok) {
        return response;
      }

      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      lastError = error as Error;

      if (attempt < retries) {
        const delayMs = 2 ** attempt * 500;
        logger.warn(
          { attempt, maxRetries: retries, delayMs },
          "Retrying OpenRouter API request",
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

export async function fetchAllOpenRouterModels(): Promise<OpenRouterModel[]> {
  const now = Date.now();

  if (ALL_MODELS_CACHE && now - LAST_FETCH_TIME < CACHE_DURATION) {
    return ALL_MODELS_CACHE;
  }

  try {
    const response = await fetchWithRetry(
      "https://openrouter.ai/api/v1/models",
    );

    const data: OpenRouterModelsResponse = await response.json();

    MODELS_CACHE.clear();
    for (const model of data.data) {
      MODELS_CACHE.set(model.id, model);
    }

    pruneCacheIfNeeded();

    ALL_MODELS_CACHE = data.data;
    LAST_FETCH_TIME = now;

    logger.info(
      { modelCount: data.data.length },
      "Fetched models from OpenRouter API",
    );

    return data.data;
  } catch (error) {
    logger.warn({ error }, "Failed to fetch from OpenRouter API");

    if (ALL_MODELS_CACHE) {
      logger.warn("Using stale cache from OpenRouter API");
      return ALL_MODELS_CACHE;
    }

    throw error;
  }
}

export async function getOpenRouterModelById(
  modelId: string,
): Promise<OpenRouterModel | null> {
  const cachedModel = MODELS_CACHE.get(modelId);
  if (cachedModel) {
    return cachedModel;
  }

  const models = await fetchAllOpenRouterModels();
  return models.find((m) => m.id === modelId) || null;
}

export function resolveCapabilitiesFromModel(
  model: OpenRouterModel,
): ModelCapabilities {
  const capabilities: Set<ModelCapability> = new Set();
  const metadata: CapabilityMetadata = {};

  if (model.architecture) {
    parseCapabilitiesFromArchitecture(
      model.architecture,
      capabilities,
      metadata,
    );
  }

  if (model.context_length && model.context_length > 100000) {
    capabilities.add("context-window");
  }

  metadata.maxTokens = model.context_length;
  metadata.contextLength = model.context_length;
  metadata.modelName = model.name;

  if (model.top_provider) {
    metadata.maxCompletionTokens = model.top_provider.max_completion_tokens;
    metadata.isModerated = model.top_provider.is_moderated;
  }

  capabilities.add("streaming");
  metadata.supportsStreaming = true;

  capabilities.add("chat");

  return {
    capabilities: Array.from(capabilities),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

export function resolveFallbackCapabilities(
  _modelId: string,
  _provider: string,
): ModelCapabilities {
  const capabilities: Set<ModelCapability> = new Set();
  const metadata: CapabilityMetadata = {};

  capabilities.add("streaming");
  metadata.supportsStreaming = true;
  capabilities.add("chat");

  return {
    capabilities: Array.from(capabilities),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

export async function fetchModelCapabilitiesFromOpenRouter(
  modelId: string,
): Promise<ModelCapabilities | null> {
  try {
    const model = await getOpenRouterModelById(modelId);

    if (!model) {
      logger.debug({ modelId }, "Model not found in OpenRouter API");
      return null;
    }

    return resolveCapabilitiesFromModel(model);
  } catch (error) {
    logger.error(
      { error, modelId },
      "Error fetching model capabilities from OpenRouter",
    );
    return null;
  }
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
    logger.warn({ error, capabilities }, "Failed to validate capabilities");
    return { capabilities: [], metadata: {} };
  }
}

export async function getModelCapabilities(
  modelId: string,
  provider: string,
): Promise<ModelCapabilities> {
  const openRouterCapabilities =
    await fetchModelCapabilitiesFromOpenRouter(modelId);

  if (openRouterCapabilities) {
    return validateCapabilities(openRouterCapabilities);
  }

  return validateCapabilities(resolveFallbackCapabilities(modelId, provider));
}

export function clearCapabilitiesCache(): void {
  MODELS_CACHE.clear();
  ALL_MODELS_CACHE = null;
  LAST_FETCH_TIME = 0;
}

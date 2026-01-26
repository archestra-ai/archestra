import {
  TimeInMs,
  type SupportedProvider,
  SupportedProviders,
} from "@shared";
import { CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { ModelMetadataModel, TokenPriceModel } from "@/models";
import type {
  CreateModelMetadata,
  InputModality,
  OutputModality,
} from "@/types";

/**
 * OpenRouter API response structure for model metadata.
 * See: https://openrouter.ai/api/v1/models
 */
interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
    tokenizer?: string;
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
    image?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  per_request_limits?: object;
}

interface OpenRouterApiResponse {
  data: OpenRouterModel[];
}

/**
 * Cache key for tracking when we last synced from OpenRouter.
 * Uses a simple timestamp-based approach with CacheManager.
 */
const OPENROUTER_SYNC_CACHE_KEY =
  `${CacheKey.GetChatModels}-openrouter-sync-timestamp` as const;

/**
 * How long to wait between OpenRouter syncs (24 hours).
 */
const SYNC_INTERVAL_MS = 24 * TimeInMs.Hour;

/**
 * Maps OpenRouter provider names to Archestra provider names.
 * OpenRouter uses format "provider/model-name", we need to map the provider part.
 */
const OPENROUTER_PROVIDER_MAP: Record<string, SupportedProvider | null> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "gemini",
  cohere: "cohere",
  cerebras: "cerebras",
  // These providers use OpenAI-compatible API in Archestra
  "meta-llama": "openai",
  mistralai: "openai",
  deepseek: "openai",
  // Explicitly unsupported providers (return null to skip)
  allenai: null,
  nvidia: null,
  xiaomi: null,
  "arcee-ai": null,
  perplexity: null,
  "x-ai": null,
  inflection: null,
  phind: null,
  databricks: null,
  // Add more as needed
};

/**
 * Maps OpenRouter input modality strings to our InputModality type.
 */
function mapInputModality(modality: string): InputModality | null {
  const mapping: Record<string, InputModality> = {
    text: "text",
    image: "image",
    audio: "audio",
    video: "video",
    file: "file",
  };
  return mapping[modality.toLowerCase()] ?? null;
}

/**
 * Maps OpenRouter output modality strings to our OutputModality type.
 */
function mapOutputModality(modality: string): OutputModality | null {
  const mapping: Record<string, OutputModality> = {
    text: "text",
    image: "image",
    audio: "audio",
  };
  return mapping[modality.toLowerCase()] ?? null;
}

/**
 * Parses OpenRouter model ID to extract provider and model ID.
 * OpenRouter format: "provider/model-name" (e.g., "openai/gpt-4o")
 * Returns null if the provider is not supported.
 */
function parseOpenRouterId(openrouterId: string): {
  provider: SupportedProvider;
  modelId: string;
} | null {
  const slashIndex = openrouterId.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }

  const openrouterProvider = openrouterId.substring(0, slashIndex);
  const modelId = openrouterId.substring(slashIndex + 1);

  // Check if we have a mapping for this provider
  const mappedProvider = OPENROUTER_PROVIDER_MAP[openrouterProvider];
  if (mappedProvider === undefined) {
    // Unknown provider - log once and skip
    logger.debug(
      { openrouterProvider, openrouterId },
      "Unknown OpenRouter provider, skipping",
    );
    return null;
  }

  if (mappedProvider === null) {
    // Explicitly unsupported provider
    return null;
  }

  return { provider: mappedProvider, modelId };
}

/**
 * Determines if a model supports tool calling based on its description or name.
 * OpenRouter doesn't have an explicit "supports_function_calling" field,
 * so we infer from common patterns.
 */
function inferToolCallingSupport(model: OpenRouterModel): boolean | null {
  const description = model.description?.toLowerCase() ?? "";
  const name = model.name?.toLowerCase() ?? "";
  const id = model.id?.toLowerCase() ?? "";

  // Models that commonly support tool calling
  const toolCallingPatterns = [
    "function calling",
    "tool use",
    "tool calling",
    "tools",
    "function-calling",
  ];

  if (
    toolCallingPatterns.some(
      (pattern) => description.includes(pattern) || name.includes(pattern),
    )
  ) {
    return true;
  }

  // Well-known models that support tool calling
  const knownToolCallingModels = [
    "gpt-4",
    "gpt-3.5-turbo",
    "claude-3",
    "claude-2",
    "gemini",
    "command-r",
  ];

  if (knownToolCallingModels.some((pattern) => id.includes(pattern))) {
    return true;
  }

  // We can't determine for sure
  return null;
}

/**
 * Converts OpenRouter model to our CreateModelMetadata format.
 */
function convertToModelMetadata(
  model: OpenRouterModel,
): CreateModelMetadata | null {
  const parsed = parseOpenRouterId(model.id);
  if (!parsed) {
    return null;
  }

  const { provider, modelId } = parsed;

  // Map input modalities
  const inputModalities: InputModality[] = [];
  if (model.architecture?.input_modalities) {
    for (const mod of model.architecture.input_modalities) {
      const mapped = mapInputModality(mod);
      if (mapped) {
        inputModalities.push(mapped);
      }
    }
  }
  // If no input modalities specified, assume text
  if (inputModalities.length === 0) {
    inputModalities.push("text");
  }

  // Map output modalities
  const outputModalities: OutputModality[] = [];
  if (model.architecture?.output_modalities) {
    for (const mod of model.architecture.output_modalities) {
      const mapped = mapOutputModality(mod);
      if (mapped) {
        outputModalities.push(mapped);
      }
    }
  }
  // If no output modalities specified, assume text
  if (outputModalities.length === 0) {
    outputModalities.push("text");
  }

  // Get context length (prefer top_provider if available)
  const contextLength =
    model.top_provider?.context_length ?? model.context_length ?? null;

  // Parse pricing (OpenRouter prices are per token as strings)
  const promptPricePerToken = model.pricing?.prompt ?? null;
  const completionPricePerToken = model.pricing?.completion ?? null;

  return {
    openrouterId: model.id,
    provider,
    modelId,
    description: model.description ?? null,
    contextLength,
    inputModalities,
    outputModalities,
    supportsToolCalling: inferToolCallingSupport(model),
    promptPricePerToken,
    completionPricePerToken,
    lastSyncedAt: new Date(),
  };
}

/**
 * OpenRouter Model Registry Service.
 *
 * Fetches model metadata from OpenRouter API and syncs it to our database.
 * Provides caching to avoid excessive API calls.
 */
class OpenRouterModelRegistry {
  private readonly apiUrl = "https://openrouter.ai/api/v1/models";

  /**
   * Fetches all models from OpenRouter API.
   */
  async fetchModelsFromApi(): Promise<OpenRouterModel[]> {
    try {
      const response = await fetch(this.apiUrl);

      if (!response.ok) {
        logger.error(
          { status: response.status },
          "Failed to fetch models from OpenRouter API",
        );
        return [];
      }

      const data = (await response.json()) as OpenRouterApiResponse;
      return data.data ?? [];
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Error fetching models from OpenRouter API",
      );
      return [];
    }
  }

  /**
   * Checks if we need to sync based on the last sync timestamp.
   */
  async shouldSync(): Promise<boolean> {
    const lastSyncTime = await cacheManager.get<number>(
      OPENROUTER_SYNC_CACHE_KEY,
    );

    if (!lastSyncTime) {
      return true;
    }

    const timeSinceLastSync = Date.now() - lastSyncTime;
    return timeSinceLastSync >= SYNC_INTERVAL_MS;
  }

  /**
   * Updates the last sync timestamp in cache.
   */
  async updateSyncTimestamp(): Promise<void> {
    await cacheManager.set(
      OPENROUTER_SYNC_CACHE_KEY,
      Date.now(),
      SYNC_INTERVAL_MS,
    );
  }

  /**
   * Syncs model metadata from OpenRouter to our database.
   * Only syncs if the cache has expired (24h by default).
   *
   * @param force - If true, bypass cache and sync immediately
   * @returns Number of models synced
   */
  async syncModelMetadata(force = false): Promise<number> {
    // Check if we need to sync
    if (!force && !(await this.shouldSync())) {
      logger.debug("OpenRouter model metadata sync skipped (cache still valid)");
      return 0;
    }

    logger.info("Starting OpenRouter model metadata sync");

    // Fetch models from API
    const openrouterModels = await this.fetchModelsFromApi();
    if (openrouterModels.length === 0) {
      logger.warn("No models returned from OpenRouter API");
      return 0;
    }

    logger.info(
      { totalModels: openrouterModels.length },
      "Fetched models from OpenRouter API",
    );

    // Convert to our format, filtering out unsupported providers
    const metadataToSync: CreateModelMetadata[] = [];
    const skippedProviders = new Set<string>();

    for (const model of openrouterModels) {
      const metadata = convertToModelMetadata(model);
      if (metadata) {
        metadataToSync.push(metadata);
      } else {
        // Track skipped providers for logging
        const provider = model.id.split("/")[0];
        if (provider) {
          skippedProviders.add(provider);
        }
      }
    }

    logger.info(
      {
        modelsToSync: metadataToSync.length,
        skippedProviders: Array.from(skippedProviders),
      },
      "Filtered models for sync",
    );

    // Bulk upsert to database
    if (metadataToSync.length > 0) {
      await ModelMetadataModel.bulkUpsert(metadataToSync);

      // Also auto-populate token_price table for models that don't have manual entries
      await this.syncTokenPrices(metadataToSync);
    }

    // Update cache timestamp
    await this.updateSyncTimestamp();

    logger.info(
      { syncedCount: metadataToSync.length },
      "OpenRouter model metadata sync completed",
    );

    return metadataToSync.length;
  }

  /**
   * Auto-populates token_price table with pricing from OpenRouter.
   * Only creates entries for models that don't already have pricing.
   */
  private async syncTokenPrices(
    metadataList: CreateModelMetadata[],
  ): Promise<void> {
    let createdCount = 0;

    for (const metadata of metadataList) {
      // Skip if no pricing data
      if (!metadata.promptPricePerToken || !metadata.completionPricePerToken) {
        continue;
      }

      // Convert per-token to per-million
      const pricePerMillionInput = (
        Number.parseFloat(metadata.promptPricePerToken) * 1_000_000
      ).toFixed(2);
      const pricePerMillionOutput = (
        Number.parseFloat(metadata.completionPricePerToken) * 1_000_000
      ).toFixed(2);

      // Create if not exists (don't overwrite manual entries)
      const created = await TokenPriceModel.createIfNotExists(
        metadata.modelId,
        {
          provider: metadata.provider,
          pricePerMillionInput,
          pricePerMillionOutput,
        },
      );

      if (created) {
        createdCount++;
      }
    }

    if (createdCount > 0) {
      logger.info(
        { createdCount },
        "Auto-populated token prices from OpenRouter data",
      );
    }
  }

  /**
   * Convenience method to sync if needed (non-blocking).
   * Call this in the models route to trigger background sync.
   */
  syncIfNeeded(): void {
    // Fire and forget - don't await
    this.syncModelMetadata().catch((error) => {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Background OpenRouter sync failed",
      );
    });
  }
}

export const openRouterModelRegistry = new OpenRouterModelRegistry();

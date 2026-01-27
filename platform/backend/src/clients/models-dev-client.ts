import { type SupportedProvider, TimeInMs } from "@shared";
import { CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { ModelMetadataModel, TokenPriceModel } from "@/models";
import {
  type CreateModelMetadata,
  type ModelInputModality,
  ModelInputModalitySchema,
  type ModelOutputModality,
  ModelOutputModalitySchema,
} from "@/types";

/**
 * Cache key for tracking when we last synced from models.dev.
 */
const MODELS_DEV_SYNC_CACHE_KEY =
  `${CacheKey.GetChatModels}-models-dev-sync-timestamp` as const;

/**
 * How long to wait between models.dev syncs (24 hours).
 */
const SYNC_INTERVAL_MS = 24 * TimeInMs.Hour;

/**
 * models.dev API endpoint
 */
const MODELS_DEV_API_URL = "https://models.dev/api.json";

/**
 * Maps models.dev provider IDs to Archestra provider names.
 */
const MODELS_DEV_PROVIDER_MAP: Record<string, SupportedProvider | null> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "gemini",
  "google-vertex": "gemini",
  cohere: "cohere",
  cerebras: "cerebras",
  mistral: "mistral",
  // These providers use OpenAI-compatible API in Archestra
  llama: "openai",
  deepseek: "openai",
  groq: "openai",
  "fireworks-ai": "openai",
  togetherai: "openai",
  // Explicitly unsupported providers (return null to skip)
  perplexity: null,
  xai: null,
  nvidia: null,
  "amazon-bedrock": null,
  azure: null,
};

// ============================================================================
// Types for models.dev API response
// ============================================================================

/**
 * Cost information for a model (prices per million tokens in USD)
 */
export type ModelsDevCost = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
  input_audio?: number;
  output_audio?: number;
};

/**
 * Token limits for a model
 */
export type ModelsDevLimit = {
  context?: number;
  input?: number;
  output?: number;
};

/**
 * Input/output modalities for a model
 */
export type ModelsDevModalities = {
  input?: string[];
  output?: string[];
};

/**
 * Model status indicator
 */
export type ModelsDevStatus = "alpha" | "beta" | "deprecated";

/**
 * A single model from the models.dev API
 */
export type ModelsDevModel = {
  id: string;
  name: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  modalities?: ModelsDevModalities;
  open_weights?: boolean;
  cost?: ModelsDevCost;
  limit?: ModelsDevLimit;
  status?: ModelsDevStatus;
};

/**
 * A provider from the models.dev API
 */
export type ModelsDevProvider = {
  id: string;
  name: string;
  npm?: string;
  env?: string[];
  doc?: string;
  api?: string | null;
  models: Record<string, ModelsDevModel>;
};

/**
 * The full models.dev API response
 */
export type ModelsDevApiResponse = Record<string, ModelsDevProvider>;

// ============================================================================
// Client implementation
// ============================================================================

/**
 * models.dev Model Registry Client.
 *
 * Fetches model metadata from models.dev API and syncs it to our database.
 * Provides caching to avoid excessive API calls.
 */
class ModelsDevClient {
  /**
   * Fetches all providers and models from models.dev API.
   */
  async fetchModelsFromApi(): Promise<ModelsDevApiResponse> {
    try {
      const response = await fetch(MODELS_DEV_API_URL);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return (await response.json()) as ModelsDevApiResponse;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Error fetching models from models.dev API",
      );
      return {};
    }
  }

  /**
   * Maps a models.dev provider ID to an Archestra provider.
   * Returns null if the provider is not supported.
   */
  mapProvider(providerId: string): SupportedProvider | null {
    const mappedProvider = MODELS_DEV_PROVIDER_MAP[providerId];
    if (mappedProvider === undefined) {
      logger.debug({ providerId }, "Unknown models.dev provider, skipping");
      return null;
    }
    return mappedProvider;
  }

  /**
   * Converts a models.dev model to our CreateModelMetadata format.
   * Returns null if the model's provider is not supported.
   */
  convertToModelMetadata(
    providerId: string,
    model: ModelsDevModel,
  ): CreateModelMetadata | null {
    const provider = this.mapProvider(providerId);
    if (!provider) {
      return null;
    }

    // Map input modalities using Zod schema for validation
    const inputModalities: ModelInputModality[] = [];
    for (const mod of model.modalities?.input ?? []) {
      const result = ModelInputModalitySchema.safeParse(mod);
      if (result.success) {
        inputModalities.push(result.data);
      }
    }
    if (inputModalities.length === 0) {
      inputModalities.push("text");
    }

    // Map output modalities using Zod schema for validation
    const outputModalities: ModelOutputModality[] = [];
    for (const mod of model.modalities?.output ?? []) {
      const result = ModelOutputModalitySchema.safeParse(mod);
      if (result.success) {
        outputModalities.push(result.data);
      }
    }
    if (outputModalities.length === 0) {
      outputModalities.push("text");
    }

    // Convert cost from per-million to per-token (store as string for precision)
    const promptPricePerToken =
      model.cost?.input !== undefined
        ? (model.cost.input / 1_000_000).toString()
        : null;
    const completionPricePerToken =
      model.cost?.output !== undefined
        ? (model.cost.output / 1_000_000).toString()
        : null;

    return {
      externalId: `${providerId}/${model.id}`,
      provider,
      modelId: model.id,
      description: model.name,
      contextLength: model.limit?.context ?? null,
      inputModalities,
      outputModalities,
      supportsToolCalling: model.tool_call ?? false,
      promptPricePerToken,
      completionPricePerToken,
      lastSyncedAt: new Date(),
    };
  }

  /**
   * Checks if we need to sync based on the last sync timestamp.
   */
  async shouldSync(): Promise<boolean> {
    const lastSyncTime = await cacheManager.get<number>(
      MODELS_DEV_SYNC_CACHE_KEY,
    );

    if (!lastSyncTime) {
      return true;
    }

    const timeSinceLastSync = Date.now() - lastSyncTime;
    return timeSinceLastSync >= SYNC_INTERVAL_MS;
  }

  /**
   * Syncs model metadata from models.dev to our database.
   * Only syncs if the cache has expired (24h by default).
   *
   * @param force - If true, bypass cache and sync immediately
   * @returns Number of models synced
   */
  async syncModelMetadata(force = false): Promise<number> {
    if (!force && !(await this.shouldSync())) {
      logger.debug(
        "models.dev model metadata sync skipped (cache still valid)",
      );
      return 0;
    }

    logger.info("Starting models.dev model metadata sync");

    const apiResponse = await this.fetchModelsFromApi();
    const providerIds = Object.keys(apiResponse);

    if (providerIds.length === 0) {
      logger.warn("No providers returned from models.dev API");
      return 0;
    }

    logger.info(
      { totalProviders: providerIds.length },
      "Fetched providers from models.dev API",
    );

    const metadataToSync: CreateModelMetadata[] = [];
    const skippedProviders = new Set<string>();
    let totalModels = 0;

    for (const providerId of providerIds) {
      const provider = apiResponse[providerId];
      if (!provider.models) {
        continue;
      }

      for (const modelId of Object.keys(provider.models)) {
        totalModels++;
        const model = provider.models[modelId];
        const metadata = this.convertToModelMetadata(providerId, model);

        if (metadata) {
          metadataToSync.push(metadata);
        } else {
          skippedProviders.add(providerId);
        }
      }
    }

    logger.info(
      {
        totalModels,
        modelsToSync: metadataToSync.length,
        skippedProviders: Array.from(skippedProviders),
      },
      "Filtered models for sync",
    );

    if (metadataToSync.length > 0) {
      await ModelMetadataModel.bulkUpsert(metadataToSync);
      await this.syncTokenPrices(metadataToSync);
    }

    await this.updateSyncTimestamp();

    logger.info(
      { syncedCount: metadataToSync.length },
      "models.dev model metadata sync completed",
    );

    return metadataToSync.length;
  }

  /**
   * Convenience method to sync if needed (non-blocking).
   * Call this in the models route to trigger background sync.
   */
  syncIfNeeded(): void {
    this.syncModelMetadata().catch((error) => {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Background models.dev sync failed",
      );
    });
  }

  /**
   * Updates the last sync timestamp in cache.
   */
  private async updateSyncTimestamp(): Promise<void> {
    await cacheManager.set(
      MODELS_DEV_SYNC_CACHE_KEY,
      Date.now(),
      SYNC_INTERVAL_MS,
    );
  }

  /**
   * Auto-populates token_price table with pricing from models.dev.
   * Only creates entries for models that don't already have pricing.
   */
  private async syncTokenPrices(
    metadataList: CreateModelMetadata[],
  ): Promise<void> {
    let createdCount = 0;

    for (const metadata of metadataList) {
      if (!metadata.promptPricePerToken || !metadata.completionPricePerToken) {
        continue;
      }

      const pricePerMillionInput = (
        Number.parseFloat(metadata.promptPricePerToken) * 1_000_000
      ).toFixed(2);
      const pricePerMillionOutput = (
        Number.parseFloat(metadata.completionPricePerToken) * 1_000_000
      ).toFixed(2);

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
        "Auto-populated token prices from models.dev data",
      );
    }
  }
}

export const modelsDevClient = new ModelsDevClient();

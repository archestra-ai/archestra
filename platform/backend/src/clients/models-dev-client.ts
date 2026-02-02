import { type SupportedProvider, TimeInMs } from "@shared";
import { z } from "zod";
import { CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { ModelModel, TokenPriceModel } from "@/models";
import {
  type CreateModel,
  type ModelInputModality,
  ModelInputModalitySchema,
  type ModelOutputModality,
  ModelOutputModalitySchema,
} from "@/types";

/**
 * Cache key for tracking when we last synced from models.dev.
 */
const MODELS_DEV_SYNC_CACHE_KEY =
  `${CacheKey.ModelsDevSync}-timestamp` as const;

/**
 * How long to wait between models.dev syncs (24 hours).
 */
const SYNC_INTERVAL_MS = 24 * TimeInMs.Hour;

/**
 * models.dev API endpoint
 */
const MODELS_DEV_API_URL = "https://models.dev/api.json";

/**
 * Retry configuration for background sync
 */
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
} as const;

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
// Zod schemas for API response validation
// ============================================================================

const ModelsDevCostSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    reasoning: z.number().optional(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
    input_audio: z.number().optional(),
    output_audio: z.number().optional(),
  })
  .optional();

const ModelsDevLimitSchema = z
  .object({
    context: z.number().optional(),
    input: z.number().optional(),
    output: z.number().optional(),
  })
  .optional();

const ModelsDevModalitiesSchema = z
  .object({
    input: z.array(z.string()).optional(),
    output: z.array(z.string()).optional(),
  })
  .optional();

const ModelsDevModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  knowledge: z.string().optional(),
  release_date: z.string().optional(),
  last_updated: z.string().optional(),
  modalities: ModelsDevModalitiesSchema,
  open_weights: z.boolean().optional(),
  cost: ModelsDevCostSchema,
  limit: ModelsDevLimitSchema,
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
});

const ModelsDevProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  npm: z.string().optional(),
  env: z.array(z.string()).optional(),
  doc: z.string().optional(),
  api: z.string().nullable().optional(),
  models: z.record(z.string(), ModelsDevModelSchema),
});

const ModelsDevApiResponseSchema = z.record(
  z.string(),
  ModelsDevProviderSchema,
);

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
   * Validates the response against the expected schema.
   */
  async fetchModelsFromApi(): Promise<ModelsDevApiResponse> {
    try {
      const response = await fetch(MODELS_DEV_API_URL);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const json = await response.json();
      const parseResult = ModelsDevApiResponseSchema.safeParse(json);

      if (!parseResult.success) {
        logger.warn(
          { errors: parseResult.error.format() },
          "models.dev API response validation failed, using partial data",
        );
        // Fall back to casting if validation fails - the API may have added new fields
        return json as ModelsDevApiResponse;
      }

      return parseResult.data;
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
   * Converts a models.dev model to our CreateModel format.
   * Returns null if the model's provider is not supported.
   */
  convertToModel(
    providerId: string,
    model: ModelsDevModel,
  ): CreateModel | null {
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

    const modelsToSync: CreateModel[] = [];
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
        const converted = this.convertToModel(providerId, model);

        if (converted) {
          modelsToSync.push(converted);
        } else {
          skippedProviders.add(providerId);
        }
      }
    }

    // Deduplicate models by (provider, modelId) key - this can happen when
    // multiple models.dev providers map to the same Archestra provider
    // (e.g., both google and google-vertex map to gemini).
    //
    // We use a deterministic priority system: prefer direct API providers over
    // derived/vertex providers. The externalId contains the original models.dev
    // provider (e.g., "google/gemini-2.5-flash" vs "google-vertex/gemini-2.5-flash").
    const preferredSourcePrefixes: Record<SupportedProvider, string[]> = {
      gemini: ["google/"], // Prefer google over google-vertex
      openai: ["openai/", "deepseek/"], // Prefer direct providers over aggregators
      anthropic: ["anthropic/"],
      cohere: ["cohere/"],
      cerebras: ["cerebras/"],
      mistral: ["mistral/"],
      bedrock: ["amazon-bedrock/"],
      ollama: ["ollama/"],
      vllm: ["vllm/"],
      zhipuai: ["zhipuai/"],
    };

    const getSourcePriority = (model: CreateModel): number => {
      const prefixes = preferredSourcePrefixes[model.provider] ?? [];
      for (let i = 0; i < prefixes.length; i++) {
        if (model.externalId.startsWith(prefixes[i])) {
          return i; // Lower index = higher priority
        }
      }
      return prefixes.length; // Not in preferred list = lowest priority
    };

    const deduplicatedModels = new Map<string, CreateModel>();
    for (const model of modelsToSync) {
      const key = `${model.provider}:${model.modelId}`;
      const existing = deduplicatedModels.get(key);

      if (!existing) {
        deduplicatedModels.set(key, model);
      } else {
        // Keep the model with higher priority (lower priority number)
        const modelPriority = getSourcePriority(model);
        const existingPriority = getSourcePriority(existing);

        if (modelPriority < existingPriority) {
          deduplicatedModels.set(key, model);
        }
        // Otherwise keep existing (same priority = first occurrence wins)
      }
    }
    const uniqueModelsToSync = Array.from(deduplicatedModels.values());

    logger.info(
      {
        totalModels,
        modelsToSync: modelsToSync.length,
        uniqueModelsToSync: uniqueModelsToSync.length,
        duplicatesRemoved: modelsToSync.length - uniqueModelsToSync.length,
        skippedProviders: Array.from(skippedProviders),
      },
      "Filtered models for sync",
    );

    if (uniqueModelsToSync.length > 0) {
      await ModelModel.bulkUpsert(uniqueModelsToSync);
      await this.syncTokenPrices(uniqueModelsToSync);
    }

    await this.updateSyncTimestamp();

    logger.info(
      { syncedCount: uniqueModelsToSync.length },
      "models.dev model metadata sync completed",
    );

    return uniqueModelsToSync.length;
  }

  /**
   * Convenience method to sync if needed (non-blocking).
   * Call this in the models route to trigger background sync.
   * Uses exponential backoff retry for transient failures.
   */
  syncIfNeeded(): void {
    this.syncWithRetry().catch((error) => {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Background models.dev sync failed after all retries",
      );
    });
  }

  /**
   * Attempts to sync model metadata with exponential backoff retry.
   */
  private async syncWithRetry(): Promise<number> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      try {
        return await this.syncModelMetadata();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < RETRY_CONFIG.maxRetries) {
          const delayMs = Math.min(
            RETRY_CONFIG.baseDelayMs * 2 ** attempt,
            RETRY_CONFIG.maxDelayMs,
          );

          logger.warn(
            {
              attempt: attempt + 1,
              maxRetries: RETRY_CONFIG.maxRetries,
              delayMs,
              error: lastError.message,
            },
            "models.dev sync failed, retrying",
          );

          await this.sleep(delayMs);
        }
      }
    }

    throw lastError;
  }

  /**
   * Sleeps for the specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
   * Uses bulk insert for efficiency.
   */
  private async syncTokenPrices(models: CreateModel[]): Promise<void> {
    const tokenPricesToCreate: Array<{
      model: string;
      provider: (typeof models)[number]["provider"];
      pricePerMillionInput: string;
      pricePerMillionOutput: string;
    }> = [];

    for (const model of models) {
      if (!model.promptPricePerToken || !model.completionPricePerToken) {
        continue;
      }

      const inputPrice = Number.parseFloat(model.promptPricePerToken);
      const outputPrice = Number.parseFloat(model.completionPricePerToken);

      // Skip if either price is NaN (invalid numeric string)
      if (Number.isNaN(inputPrice) || Number.isNaN(outputPrice)) {
        logger.warn(
          {
            modelId: model.modelId,
            provider: model.provider,
            promptPricePerToken: model.promptPricePerToken,
            completionPricePerToken: model.completionPricePerToken,
          },
          "Skipping token price sync due to invalid pricing data",
        );
        continue;
      }

      tokenPricesToCreate.push({
        model: model.modelId,
        provider: model.provider,
        pricePerMillionInput: (inputPrice * 1_000_000).toFixed(2),
        pricePerMillionOutput: (outputPrice * 1_000_000).toFixed(2),
      });
    }

    if (tokenPricesToCreate.length === 0) {
      return;
    }

    const createdCount =
      await TokenPriceModel.bulkCreateIfNotExists(tokenPricesToCreate);

    if (createdCount > 0) {
      logger.info(
        { createdCount },
        "Auto-populated token prices from models.dev data",
      );
    }
  }
}

export const modelsDevClient = new ModelsDevClient();

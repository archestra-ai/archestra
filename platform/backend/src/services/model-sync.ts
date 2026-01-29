import type { SupportedProvider } from "@shared";
import { modelsDevClient } from "@/clients/models-dev-client";
import logger from "@/logging";
import { ApiKeyModelModel, ModelModel } from "@/models";
import type {
  CreateModel,
  ModelInputModality,
  ModelOutputModality,
} from "@/types";
import { ModelInputModalitySchema, ModelOutputModalitySchema } from "@/types";

interface ModelFromProvider {
  id: string;
  displayName: string;
  provider: SupportedProvider;
  createdAt?: string;
}

type ModelFetcher = (apiKey: string) => Promise<ModelFromProvider[]>;

/**
 * Service for syncing models from provider APIs to the database.
 *
 * When a new API key is added or models are refreshed, this service:
 * 1. Fetches models from the provider API using the given API key
 * 2. Upserts all models to the `models` table (creates new ones, updates existing)
 * 3. Links the models to the API key via the `api_key_models` join table
 */
class ModelSyncService {
  private modelFetchers: Map<SupportedProvider, ModelFetcher> = new Map();

  /**
   * Register a model fetcher function for a provider.
   * This allows the routes.models.ts to register its fetch functions.
   */
  registerFetcher(provider: SupportedProvider, fetcher: ModelFetcher): void {
    this.modelFetchers.set(provider, fetcher);
  }

  /**
   * Sync models for a specific API key.
   * Fetches models from the provider and links them to the API key.
   *
   * @param apiKeyId - The database ID of the chat_api_key
   * @param provider - The provider for this API key
   * @param apiKeyValue - The actual API key value for making API calls
   * @returns The number of models synced
   */
  async syncModelsForApiKey(
    apiKeyId: string,
    provider: SupportedProvider,
    apiKeyValue: string,
  ): Promise<number> {
    const fetcher = this.modelFetchers.get(provider);

    if (!fetcher) {
      logger.warn(
        { provider },
        "No model fetcher registered for provider, skipping sync",
      );
      return 0;
    }

    try {
      // 1. Fetch models from provider API
      const providerModels = await fetcher(apiKeyValue);

      if (providerModels.length === 0) {
        logger.info({ provider, apiKeyId }, "No models returned from provider");
        // Clear any existing links since no models are available
        await ApiKeyModelModel.syncModelsForApiKey(apiKeyId, [], provider);
        return 0;
      }

      logger.info(
        { provider, apiKeyId, modelCount: providerModels.length },
        "Fetched models from provider",
      );

      // 2. Fetch models.dev data for capabilities
      const modelsDevData = await modelsDevClient.fetchModelsFromApi();

      // 3. Build a lookup map for models.dev capabilities
      const capabilitiesMap = buildCapabilitiesMap(modelsDevData, provider);

      // 4. Merge provider models with models.dev capabilities
      const modelsToUpsert: CreateModel[] = providerModels.map((model) => {
        const capabilities = capabilitiesMap.get(model.id);
        return {
          externalId: `${model.provider}/${model.id}`,
          provider: model.provider,
          modelId: model.id,
          description: capabilities?.description ?? null,
          contextLength: capabilities?.contextLength ?? null,
          inputModalities: capabilities?.inputModalities ?? null,
          outputModalities: capabilities?.outputModalities ?? null,
          supportsToolCalling: capabilities?.supportsToolCalling ?? null,
          promptPricePerToken: capabilities?.promptPricePerToken ?? null,
          completionPricePerToken:
            capabilities?.completionPricePerToken ?? null,
          lastSyncedAt: new Date(),
        };
      });

      const upsertedModels = await ModelModel.bulkUpsert(modelsToUpsert);

      logger.info(
        { provider, apiKeyId, upsertedCount: upsertedModels.length },
        "Upserted models to database",
      );

      // 3. Link models to the API key with fastest/best detection
      const modelsWithIds = upsertedModels.map((m) => ({
        id: m.id,
        modelId: m.modelId,
      }));
      await ApiKeyModelModel.syncModelsForApiKey(
        apiKeyId,
        modelsWithIds,
        provider,
      );

      logger.info(
        { provider, apiKeyId, linkedCount: modelsWithIds.length },
        "Linked models to API key",
      );

      return modelsWithIds.length;
    } catch (error) {
      logger.error(
        {
          provider,
          apiKeyId,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "Error syncing models for API key",
      );
      throw error;
    }
  }

  /**
   * Sync models for multiple API keys.
   * Used when refreshing all models.
   */
  async syncModelsForApiKeys(
    apiKeys: Array<{
      id: string;
      provider: SupportedProvider;
      apiKeyValue: string;
    }>,
  ): Promise<Map<string, number>> {
    const results = new Map<string, number>();

    for (const apiKey of apiKeys) {
      try {
        const count = await this.syncModelsForApiKey(
          apiKey.id,
          apiKey.provider,
          apiKey.apiKeyValue,
        );
        results.set(apiKey.id, count);
      } catch (error) {
        logger.error(
          {
            apiKeyId: apiKey.id,
            provider: apiKey.provider,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
          "Failed to sync models for API key, continuing with others",
        );
        results.set(apiKey.id, 0);
      }
    }

    return results;
  }

  /**
   * Check if a fetcher is registered for a provider.
   */
  hasFetcher(provider: SupportedProvider): boolean {
    return this.modelFetchers.has(provider);
  }
}

// Export singleton instance
export const modelSyncService = new ModelSyncService();

// ============================================================================
// Helper functions
// ============================================================================

export interface ModelCapabilities {
  description: string | null;
  contextLength: number | null;
  inputModalities: ModelInputModality[] | null;
  outputModalities: ModelOutputModality[] | null;
  supportsToolCalling: boolean | null;
  promptPricePerToken: string | null;
  completionPricePerToken: string | null;
}

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
  llama: "openai",
  deepseek: "openai",
  groq: "openai",
  "fireworks-ai": "openai",
  togetherai: "openai",
  perplexity: null,
  xai: null,
  nvidia: null,
  "amazon-bedrock": "bedrock",
  azure: null,
};

/**
 * Build a map of modelId -> capabilities from models.dev data for a specific provider.
 */
export function buildCapabilitiesMap(
  modelsDevData: Record<
    string,
    {
      models: Record<
        string,
        {
          id: string;
          name: string;
          tool_call?: boolean;
          limit?: { context?: number };
          modalities?: { input?: string[]; output?: string[] };
          cost?: { input?: number; output?: number };
        }
      >;
    }
  >,
  targetProvider: SupportedProvider,
): Map<string, ModelCapabilities> {
  const map = new Map<string, ModelCapabilities>();

  for (const [providerId, providerData] of Object.entries(modelsDevData)) {
    const mappedProvider = MODELS_DEV_PROVIDER_MAP[providerId];
    if (mappedProvider !== targetProvider) {
      continue;
    }

    for (const [, model] of Object.entries(providerData.models ?? {})) {
      const promptPrice =
        model.cost?.input !== undefined
          ? (model.cost.input / 1_000_000).toString()
          : null;
      const completionPrice =
        model.cost?.output !== undefined
          ? (model.cost.output / 1_000_000).toString()
          : null;

      // Validate input modalities using Zod schema
      const inputModalities = parseModalities(
        model.modalities?.input,
        ModelInputModalitySchema,
      );

      // Validate output modalities using Zod schema
      const outputModalities = parseModalities(
        model.modalities?.output,
        ModelOutputModalitySchema,
      );

      map.set(model.id, {
        description: model.name,
        contextLength: model.limit?.context ?? null,
        inputModalities,
        outputModalities,
        supportsToolCalling: model.tool_call ?? null,
        promptPricePerToken: promptPrice,
        completionPricePerToken: completionPrice,
      });
    }
  }

  return map;
}

/**
 * Parse and validate modalities array using Zod schema.
 * Returns null if input is undefined/empty, otherwise returns validated modalities.
 */
function parseModalities<T>(
  modalities: string[] | undefined,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
): T[] | null {
  if (!modalities || modalities.length === 0) {
    return null;
  }

  const validated: T[] = [];
  for (const mod of modalities) {
    const result = schema.safeParse(mod);
    if (result.success && result.data !== undefined) {
      validated.push(result.data);
    }
  }

  return validated.length > 0 ? validated : null;
}

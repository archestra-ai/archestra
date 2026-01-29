import type { SupportedProvider } from "@shared";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { modelsDevClient } from "@/clients/models-dev-client";
import logger from "@/logging";
import { ApiKeyModelModel, ChatApiKeyModel, ModelModel } from "@/models";
import { buildCapabilitiesMap } from "@/services/model-sync";
import type { CreateModel } from "@/types";

/**
 * Configuration for a keyless provider that uses system API keys.
 */
interface KeylessProviderConfig {
  provider: SupportedProvider;
  name: string;
  isEnabled: () => boolean;
  /** Custom fetch function for providers that need special handling (e.g., Vertex AI) */
  customFetch: () => Promise<Array<{ id: string; displayName: string }>>;
}

/**
 * Manages system API keys for truly keyless providers.
 *
 * Currently only Vertex AI qualifies as keyless because it uses GCP's
 * Application Default Credentials (ADC) instead of API keys.
 *
 * Other providers (vLLM, Ollama, Bedrock) may have optional authentication
 * but should use the normal API key flow through the UI.
 *
 * System keys are auto-created when a keyless provider is enabled via environment config,
 * and auto-deleted when the provider is disabled.
 */
class SystemKeyManager {
  /**
   * Registry of keyless providers that need system API keys.
   * Only Vertex AI is truly keyless (uses ADC).
   */
  private readonly keylessProviders: KeylessProviderConfig[] = [
    {
      provider: "gemini",
      name: "Vertex AI",
      isEnabled: () => isVertexAiEnabled(),
      // Vertex AI uses ADC, not API keys - we'll use a custom fetch via dynamic import
      customFetch: async () => {
        // Dynamic import to avoid circular dependency
        const { fetchGeminiModelsViaVertexAi } = await import(
          "@/routes/chat/routes.models"
        );
        const models = await fetchGeminiModelsViaVertexAi();
        return models.map((m) => ({ id: m.id, displayName: m.displayName }));
      },
    },
  ];

  /**
   * Sync all system API keys.
   * Creates keys for enabled providers, deletes keys for disabled providers.
   *
   * @param organizationId - The organization to create system keys for
   */
  async syncSystemKeys(organizationId: string): Promise<void> {
    logger.info({ organizationId }, "Starting system API keys sync");

    for (const providerConfig of this.keylessProviders) {
      try {
        await this.syncProviderSystemKey(organizationId, providerConfig);
      } catch (error) {
        logger.error(
          {
            provider: providerConfig.provider,
            organizationId,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
          "Failed to sync system key for provider",
        );
      }
    }

    logger.info({ organizationId }, "Completed system API keys sync");
  }

  /**
   * Sync system key for a single provider.
   */
  private async syncProviderSystemKey(
    organizationId: string,
    providerConfig: KeylessProviderConfig,
  ): Promise<void> {
    const { provider, name, isEnabled, customFetch } = providerConfig;
    const enabled = isEnabled();

    const existingKey = await ChatApiKeyModel.findSystemKey(provider);

    if (enabled) {
      if (existingKey) {
        // Key exists, sync models
        logger.debug(
          { provider, apiKeyId: existingKey.id },
          "System key exists, syncing models",
        );
        await this.syncModelsForSystemKey(
          existingKey.id,
          provider,
          customFetch,
        );
      } else {
        // Create new system key
        logger.info({ provider, organizationId }, "Creating system API key");
        const newKey = await ChatApiKeyModel.createSystemKey({
          organizationId,
          name,
          provider,
        });
        await this.syncModelsForSystemKey(newKey.id, provider, customFetch);
      }
    } else {
      if (existingKey) {
        // Provider disabled, delete system key
        logger.info(
          { provider, apiKeyId: existingKey.id },
          "Deleting system API key (provider disabled)",
        );
        await ChatApiKeyModel.deleteSystemKey(provider);
      }
      // else: Provider disabled and no key exists, nothing to do
    }
  }

  /**
   * Sync models for a system key using the provider's custom fetch function.
   */
  private async syncModelsForSystemKey(
    apiKeyId: string,
    provider: SupportedProvider,
    customFetch: () => Promise<Array<{ id: string; displayName: string }>>,
  ): Promise<void> {
    try {
      await this.syncModelsWithCustomFetch(apiKeyId, provider, customFetch);
    } catch (error) {
      logger.warn(
        {
          provider,
          apiKeyId,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "Failed to sync models for system key",
      );
    }
  }

  /**
   * Sync models using a custom fetch function (for providers like Vertex AI).
   */
  private async syncModelsWithCustomFetch(
    apiKeyId: string,
    provider: SupportedProvider,
    customFetch: () => Promise<Array<{ id: string; displayName: string }>>,
  ): Promise<void> {
    const models = await customFetch();

    if (models.length === 0) {
      logger.info({ provider, apiKeyId }, "No models returned from provider");
      await ApiKeyModelModel.syncModelsForApiKey(apiKeyId, [], provider);
      return;
    }

    logger.info(
      { provider, apiKeyId, modelCount: models.length },
      "Fetched models from provider (custom fetch)",
    );

    // Fetch models.dev data for capabilities
    const modelsDevData = await modelsDevClient.fetchModelsFromApi();
    const capabilitiesMap = buildCapabilitiesMap(modelsDevData, provider);

    // Merge provider models with models.dev capabilities
    const modelsToUpsert: CreateModel[] = models.map((model) => {
      const capabilities = capabilitiesMap.get(model.id);
      return {
        externalId: `${provider}/${model.id}`,
        provider,
        modelId: model.id,
        description: capabilities?.description ?? null,
        contextLength: capabilities?.contextLength ?? null,
        inputModalities: capabilities?.inputModalities ?? null,
        outputModalities: capabilities?.outputModalities ?? null,
        supportsToolCalling: capabilities?.supportsToolCalling ?? null,
        promptPricePerToken: capabilities?.promptPricePerToken ?? null,
        completionPricePerToken: capabilities?.completionPricePerToken ?? null,
        lastSyncedAt: new Date(),
      };
    });

    const upsertedModels = await ModelModel.bulkUpsert(modelsToUpsert);

    logger.info(
      { provider, apiKeyId, upsertedCount: upsertedModels.length },
      "Upserted models to database",
    );

    // Link models to the API key with fastest/best detection
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
      "Linked models to system API key",
    );
  }

  /**
   * Get list of enabled keyless providers.
   */
  getEnabledProviders(): SupportedProvider[] {
    return this.keylessProviders
      .filter((p) => p.isEnabled())
      .map((p) => p.provider);
  }
}

// Export singleton instance
export const systemKeyManager = new SystemKeyManager();

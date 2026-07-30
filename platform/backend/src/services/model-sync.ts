import {
  MODELS_DEV_PROVIDER_MAP,
  OPENROUTER_FREE_MODEL_ID,
  SUPPORTED_EMBEDDING_DIMENSIONS,
  type SupportedEmbeddingDimension,
  type SupportedProvider,
} from "@archestra/shared";
import {
  type ModelsDevApiResponse,
  modelsDevClient,
  modelsDevCostToPerToken,
  sanitizeOutputLimit,
} from "@/clients/models-dev-client";
import logger from "@/logging";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import { modelFetchers } from "@/routes/chat/model-fetchers";
import type { FetchedModelCapabilities } from "@/routes/chat/model-fetchers/types";
import {
  type BedrockAwsPrices,
  resolveBedrockAwsPrices,
} from "@/services/bedrock-aws-pricing";
import {
  type CrossProviderMetadata,
  type CrossProviderPrices,
  registryLookupCandidates,
  resolveCrossProviderMetadata,
  resolveCrossProviderPrices,
  resolveSelfHostedModelMetadata,
} from "@/services/cross-provider-pricing";
import {
  resolveVendorPublishedPrices,
  type VendorPublishedPrices,
} from "@/services/vendor-published-pricing";
import type {
  CreateModel,
  ModelInputModality,
  ModelOutputModality,
} from "@/types";
import { ModelInputModalitySchema, ModelOutputModalitySchema } from "@/types";

/**
 * Service for syncing models from provider APIs to the database.
 *
 * When a new API key is added or models are refreshed, this service:
 * 1. Fetches models from the provider API using the given API key
 * 2. Upserts all models to the `models` table (creates new ones, updates existing)
 * 3. Links the models to the API key via the `api_key_models` join table
 */
class ModelSyncService {
  /**
   * Sync models for a specific API key.
   * Fetches models from the provider and links them to the API key.
   *
   * @param apiKeyId - The database ID of the chat_api_key
   * @param provider - The provider for this API key
   * @param apiKeyValue - The actual API key value for making API calls
   * @returns The number of models synced
   */
  async syncModelsForApiKey(params: {
    apiKeyId: string;
    provider: SupportedProvider;
    apiKeyValue: string;
    baseUrl?: string | null;
    extraHeaders?: Record<string, string> | null;
    forceRefresh?: boolean;
  }): Promise<number> {
    const {
      apiKeyId,
      provider,
      apiKeyValue,
      baseUrl,
      extraHeaders,
      forceRefresh,
    } = params;
    const fetcher = modelFetchers[provider];

    if (!fetcher) {
      logger.warn(
        { provider },
        "No model fetcher registered for provider, skipping sync",
      );
      return 0;
    }

    try {
      // 1. Fetch models from provider API
      const providerModels = await fetcher(apiKeyValue, baseUrl, extraHeaders);

      if (providerModels.length === 0) {
        logger.info({ provider, apiKeyId }, "No models returned from provider");
        // Clear any existing links since no models are available
        await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
          apiKeyId,
          [],
          provider,
        );
        return 0;
      }

      logger.info(
        { provider, apiKeyId, modelCount: providerModels.length },
        "Fetched models from provider",
      );

      // 2. Fetch models.dev data for capabilities
      const modelsDevData = await modelsDevClient.fetchModelsFromApi();

      // 3. Merge provider models with models.dev capabilities.
      // Use the API key's provider (not the fetcher's detected provider) so that
      // models from OpenAI-compatible proxies are stored under the correct provider
      // instead of being mis-classified by heuristic model ID prefix detection.
      const modelsToUpsert = buildModelsToUpsert({
        provider,
        models: providerModels,
        modelsDevData,
      });

      const upsertedModels = forceRefresh
        ? await ModelModel.bulkUpsertFull(modelsToUpsert)
        : await ModelModel.bulkUpsert(modelsToUpsert);

      logger.info(
        { provider, apiKeyId, upsertedCount: upsertedModels.length },
        "Upserted models to database",
      );

      // 4. Link models to the API key with best-model detection
      const modelsWithIds = upsertedModels.map((m) => ({
        id: m.id,
        modelId: m.modelId,
      }));
      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
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
      baseUrl?: string | null;
      extraHeaders?: Record<string, string> | null;
    }>,
    options?: { forceRefresh?: boolean },
  ): Promise<Map<string, number>> {
    const results = new Map<string, number>();

    for (const apiKey of apiKeys) {
      try {
        const count = await this.syncModelsForApiKey({
          apiKeyId: apiKey.id,
          provider: apiKey.provider,
          apiKeyValue: apiKey.apiKeyValue,
          baseUrl: apiKey.baseUrl,
          extraHeaders: apiKey.extraHeaders,
          forceRefresh: options?.forceRefresh,
        });
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
   * Give a fresh organization a zero-cost default: when an OpenRouter key is
   * added and no default model is configured, point the org default at
   * OpenRouter's Free Models Router. Never overrides an explicit user choice.
   */
  async maybeAutoSetOrgDefaultModel(params: {
    organizationId: string;
    apiKeyId: string;
    provider: SupportedProvider;
  }): Promise<void> {
    const { organizationId, apiKeyId, provider } = params;
    if (provider !== "openrouter") {
      return;
    }

    const org = await OrganizationModel.getById(organizationId);
    if (!org || org.defaultModelId || org.defaultLlmApiKeyId) {
      return;
    }

    const routerModel = await ModelModel.findByProviderAndModelId(
      "openrouter",
      OPENROUTER_FREE_MODEL_ID,
    );
    if (!routerModel) {
      return;
    }

    await OrganizationModel.patch(organizationId, {
      defaultModelId: routerModel.id,
      defaultLlmApiKeyId: apiKeyId,
    });
    logger.info(
      { organizationId, apiKeyId, modelId: routerModel.modelId },
      "Auto-selected OpenRouter Free Models Router as the organization default model",
    );
  }
}

// Export singleton instance
export const modelSyncService = new ModelSyncService();

// ============================================================================
// Helper functions
// ============================================================================

interface ProviderModelCapabilities {
  description: string | null;
  contextLength: number | null;
  outputLength: number | null;
  inputModalities: ModelInputModality[] | null;
  outputModalities: ModelOutputModality[] | null;
  supportsToolCalling: boolean | null;
  promptPricePerToken: string | null;
  completionPricePerToken: string | null;
  cacheReadPricePerToken: string | null;
  cacheWritePricePerToken: string | null;
}

export function buildModelsToUpsert(params: {
  provider: SupportedProvider;
  models: Array<{
    id: string;
    capabilities?: FetchedModelCapabilities;
    /** Underlying vendor model name, when the fetcher can determine it (Azure). */
    underlyingModelName?: string | null;
  }>;
  modelsDevData: ModelsDevApiResponse;
}): CreateModel[] {
  const { provider, models, modelsDevData } = params;
  const capabilitiesMap = buildCapabilitiesMap(modelsDevData, provider);

  // A provider catalog can list the same model id more than once — Azure AI
  // Foundry returns an entry per model/SKU, so `claude-opus-5` and friends
  // arrive twice. Two rows sharing (provider, model_id) in one INSERT make
  // Postgres reject the whole statement ("ON CONFLICT DO UPDATE command
  // cannot affect row a second time"), and since bulkUpsert runs every batch
  // in one transaction that rolls the entire sync back to zero models.
  const uniqueModels = new Map<string, (typeof models)[number]>();
  for (const model of models) {
    if (!uniqueModels.has(model.id)) {
      uniqueModels.set(model.id, model);
    }
  }

  return [...uniqueModels.values()].map((model) => {
    // Bedrock/Azure model ids don't match models.dev keys, so derive pricing and
    // capabilities from the underlying vendor entry.
    const isReseller = provider === "bedrock" || provider === "azure";
    const crossProviderArgs = {
      provider,
      modelId: model.id,
      underlyingModelName: model.underlyingModelName,
      modelsDevData,
    };
    // Fills the tail models.dev omits — retired and non-chat Bedrock models
    // that would otherwise fall through to the fabricated default estimate.
    // It sits below the registry because AWS names a model by display name,
    // so a snapshot lookup can land on a whole family ("Claude Opus 4") and
    // price a newer member at an older member's rate.
    const awsPrices = resolveBedrockAwsPrices({
      provider,
      modelId: model.id,
      underlyingModelName: model.underlyingModelName,
    });
    // Fills models the registry omits, or lists with an empty cost, from the
    // rate their own vendor publishes — otherwise they reach the same
    // fabricated estimate.
    const publishedPrices = resolveVendorPublishedPrices({
      provider,
      modelId: model.id,
    });
    const crossProviderPrices = isReseller
      ? resolveCrossProviderPrices(crossProviderArgs)
      : null;
    // A self-hosted server reports an id but no capabilities, and models.dev
    // has no entry for it to look up. Describe the model from whichever vendor
    // publishes it; the deployment's own price and window are left to the
    // fetcher, which is the only thing that can know them.
    const crossProviderMetadata = isReseller
      ? resolveCrossProviderMetadata(crossProviderArgs)
      : provider === "vllm"
        ? (resolveSelfHostedModelMetadata({
            modelId: model.id,
            modelsDevData,
          }) ?? SELF_HOSTED_TEXT_ONLY)
        : null;

    const capabilities = resolveModelCapabilities({
      provider,
      modelId: model.id,
      capabilities: lookupModelsDevCapabilities(capabilitiesMap, model.id),
      fetched: model.capabilities,
      crossProviderPrices,
      crossProviderMetadata,
      awsPrices,
      publishedPrices,
      underlyingModelName: model.underlyingModelName,
    });

    return {
      externalId: `${provider}/${model.id}`,
      provider,
      modelId: model.id,
      description: capabilities.description,
      contextLength: capabilities.contextLength,
      outputLength: capabilities.outputLength,
      inputModalities: capabilities.inputModalities,
      outputModalities: capabilities.outputModalities,
      supportsToolCalling: capabilities.supportsToolCalling,
      promptPricePerToken: capabilities.promptPricePerToken,
      completionPricePerToken: capabilities.completionPricePerToken,
      cacheReadPricePerToken: capabilities.cacheReadPricePerToken,
      cacheWritePricePerToken: capabilities.cacheWritePricePerToken,
      embeddingDimensions: resolveEmbeddingDimensions({
        modelId: model.id,
        provider,
        fetched: model.capabilities,
      }),
      defaultParameters: model.capabilities?.defaultParameters ?? null,
      lastSyncedAt: new Date(),
    };
  });
}

/**
 * Resolve a model's embedding dimension. When the provider reports embedding
 * capability authoritatively (Ollama `/api/show`), trust it and skip the name
 * heuristic entirely — including for authoritatively-generative models (avoids
 * mis-tagging a chat model whose id happens to match an embed name pattern).
 * An authoritative embedding dimension the KB cannot store (not in
 * SUPPORTED_EMBEDDING_DIMENSIONS) resolves to null rather than a broken value.
 */
function resolveEmbeddingDimensions(params: {
  modelId: string;
  provider: SupportedProvider;
  fetched?: FetchedModelCapabilities;
}): SupportedEmbeddingDimension | null {
  const { modelId, provider, fetched } = params;
  if (fetched?.embeddingDimensions !== undefined) {
    const dim = fetched.embeddingDimensions;
    return dim !== null && isSupportedEmbeddingDimension(dim) ? dim : null;
  }
  return inferEmbeddingDimensions(modelId, provider);
}

function isSupportedEmbeddingDimension(
  dimension: number,
): dimension is SupportedEmbeddingDimension {
  return (SUPPORTED_EMBEDDING_DIMENSIONS as readonly number[]).includes(
    dimension,
  );
}

/**
 * Best-effort inference of embedding dimensions for known models.
 * Unknown models return null and can be configured manually in the model editor.
 */
function inferEmbeddingDimensions(
  modelId: string,
  provider: SupportedProvider,
): SupportedEmbeddingDimension | null {
  const id = modelId.toLowerCase();
  if (
    (provider === "openai" || provider === "azure") &&
    id === "text-embedding-3-small"
  ) {
    return 1536;
  }
  if (
    (provider === "openai" || provider === "azure") &&
    id === "text-embedding-3-large"
  ) {
    // Default to 1536 for backwards compatibility with existing OpenAI KB
    // embeddings; admins can opt into 3072 manually in the model editor.
    return 1536;
  }
  if (
    provider === "openrouter" &&
    (id === "openai/text-embedding-3-small" ||
      id === "openai/text-embedding-3-large")
  ) {
    return 1536;
  }
  if (provider === "gemini" && id === "gemini-embedding-001") {
    return 3072;
  }
  if (provider === "gemini" && id === "gemini-embedding-2-preview") {
    return 3072;
  }
  if (id === "nomic-embed-text" || id.endsWith("/nomic-embed-text")) {
    return 768;
  }
  // Fallback for older Ollama that omits `/api/show` capabilities; the
  // authoritative path above wins whenever capabilities are reported. Match the
  // base name so an optional `:tag` suffix is ignored, and gate to Ollama so a
  // same-named model on another provider isn't mis-tagged.
  if (provider === "ollama" || provider === "ollama-native") {
    const base = id.split(":")[0];
    if (base === "mxbai-embed-large" || base === "bge-m3") {
      return 1024;
    }
    if (base === "all-minilm") {
      return 384;
    }
  }
  return null;
}

/** @public — exported for testability */
export function resolveModelCapabilities(params: {
  provider: SupportedProvider;
  modelId: string;
  /** Capabilities from models.dev enrichment (same-provider match). */
  capabilities?: ProviderModelCapabilities;
  /** Capabilities read directly from the provider's models endpoint. Highest priority. */
  fetched?: FetchedModelCapabilities;
  /** Prices derived from the underlying vendor entry for Bedrock/Azure. */
  crossProviderPrices?: CrossProviderPrices | null;
  /** Capabilities derived from the underlying vendor entry for Bedrock/Azure. */
  crossProviderMetadata?: CrossProviderMetadata | null;
  /** Prices published by AWS for a Bedrock model. Used where the registry has none. */
  awsPrices?: BedrockAwsPrices | null;
  /** Prices from a vendor's own list. Used where the registry has none. */
  publishedPrices?: VendorPublishedPrices | null;
  /** Underlying vendor model name, when the fetcher can determine it (Azure). */
  underlyingModelName?: string | null;
}): ProviderModelCapabilities {
  const {
    provider,
    modelId,
    capabilities,
    fetched,
    crossProviderPrices,
    crossProviderMetadata,
    awsPrices,
    publishedPrices,
    underlyingModelName,
  } = params;
  const inferredCapabilities = inferModelCapabilities({
    provider,
    modelId,
    fetched,
    underlyingModelName,
  });

  // Priority per field: fetcher -> models.dev -> hardcoded inference ->
  // cross-provider (Bedrock/Azure underlying vendor). Inference outranks the
  // cross-provider tier because it describes the model's shape on *this*
  // provider, which the resold vendor entry cannot: an Azure embedding
  // deployment emits no output modality even though the OpenAI entry it
  // resolves to lists "text".
  // Price priority: fetcher -> models.dev (same provider) -> cross-provider ->
  // vendor-published (AWS, then the vendors' own lists) -> null. The published tiers rank last so
  // they only fill what the registry omits.
  return normalizeKnownModelCapabilities({
    provider,
    modelId,
    capabilities: {
      description: capabilities?.description ?? null,
      contextLength:
        fetched?.contextLength ??
        capabilities?.contextLength ??
        inferredCapabilities.contextLength ??
        crossProviderMetadata?.contextLength ??
        null,
      outputLength:
        capabilities?.outputLength ??
        inferredCapabilities.outputLength ??
        crossProviderMetadata?.outputLength ??
        null,
      inputModalities:
        capabilities?.inputModalities ??
        inferredCapabilities.inputModalities ??
        parseModalities(
          crossProviderMetadata?.inputModalities,
          ModelInputModalitySchema,
        ),
      outputModalities:
        capabilities?.outputModalities ??
        inferredCapabilities.outputModalities ??
        parseModalities(
          crossProviderMetadata?.outputModalities,
          ModelOutputModalitySchema,
        ),
      supportsToolCalling:
        fetched?.supportsToolCalling ??
        capabilities?.supportsToolCalling ??
        inferredCapabilities.supportsToolCalling ??
        crossProviderMetadata?.supportsToolCalling ??
        null,
      promptPricePerToken:
        fetched?.promptPricePerToken ??
        capabilities?.promptPricePerToken ??
        crossProviderPrices?.promptPricePerToken ??
        awsPrices?.promptPricePerToken ??
        publishedPrices?.promptPricePerToken ??
        null,
      completionPricePerToken:
        fetched?.completionPricePerToken ??
        capabilities?.completionPricePerToken ??
        crossProviderPrices?.completionPricePerToken ??
        awsPrices?.completionPricePerToken ??
        publishedPrices?.completionPricePerToken ??
        null,
      cacheReadPricePerToken:
        fetched?.cacheReadPricePerToken ??
        capabilities?.cacheReadPricePerToken ??
        crossProviderPrices?.cacheReadPricePerToken ??
        publishedPrices?.cacheReadPricePerToken ??
        null,
      cacheWritePricePerToken:
        fetched?.cacheWritePricePerToken ??
        capabilities?.cacheWritePricePerToken ??
        crossProviderPrices?.cacheWritePricePerToken ??
        null,
    },
  });
}

/**
 * Look a model up in the models.dev map, falling back to its date-stripped id.
 *
 * Providers hand out date-pinned snapshot ids (`gpt-4o-mini-2024-07-18`) that
 * the registry keys without the date, so an exact-only lookup misses them and
 * the model falls all the way through to the flat default price. The exact key
 * still wins, making the fallback purely additive, and the fallback is itself an
 * exact lookup, so it can only match a key the registry really has.
 */
function lookupModelsDevCapabilities(
  capabilitiesMap: Map<string, ProviderModelCapabilities>,
  modelId: string,
): ProviderModelCapabilities | undefined {
  for (const candidate of registryLookupCandidates(modelId)) {
    const found = capabilitiesMap.get(candidate);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Build a map of modelId -> capabilities from models.dev data for a specific provider.
 */
function buildCapabilitiesMap(
  modelsDevData: ModelsDevApiResponse,
  targetProvider: SupportedProvider,
): Map<string, ProviderModelCapabilities> {
  const map = new Map<string, ProviderModelCapabilities>();

  for (const [providerId, providerData] of Object.entries(modelsDevData)) {
    const mappedProvider = MODELS_DEV_PROVIDER_MAP[providerId];
    if (mappedProvider !== targetProvider) {
      continue;
    }

    for (const [, model] of Object.entries(providerData.models ?? {})) {
      const prices = modelsDevCostToPerToken(model.cost);

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
        outputLength: sanitizeOutputLimit(model.limit?.output),
        inputModalities,
        outputModalities,
        supportsToolCalling: model.tool_call ?? null,
        promptPricePerToken: prices.promptPricePerToken,
        completionPricePerToken: prices.completionPricePerToken,
        cacheReadPricePerToken: prices.cacheReadPricePerToken,
        cacheWritePricePerToken: prices.cacheWritePricePerToken,
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
  modalities: string[] | null | undefined,
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

/**
 * What a self-hosted model is assumed to be when no vendor publishes it: an
 * operator's own fine-tune or a `--served-model-name` alias, which no registry
 * can describe.
 *
 * Guessing text is not free of consequence, but leaving both lists null is
 * worse than a wrong guess an admin can correct: the edit dialog requires at
 * least one input modality, so a null list makes the form invalid the moment it
 * opens and every save fails validation against a message rendered off-screen.
 */
const SELF_HOSTED_TEXT_ONLY: CrossProviderMetadata = {
  contextLength: null,
  outputLength: null,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportsToolCalling: null,
};

function inferModelCapabilities(params: {
  provider: SupportedProvider;
  modelId: string;
  fetched?: FetchedModelCapabilities;
  underlyingModelName?: string | null;
}): ProviderModelCapabilities {
  const { provider, modelId, fetched, underlyingModelName } = params;

  if (provider === "azure") {
    return inferAzureCapabilities(modelId, underlyingModelName);
  }

  if (provider === "gemini") {
    return inferGeminiCapabilities(modelId);
  }

  if (provider === "ollama" || provider === "ollama-native") {
    return inferOllamaCapabilities(fetched);
  }

  if (provider === "perplexity") {
    return inferPerplexityCapabilities();
  }

  return emptyCapabilities();
}

/**
 * Neither Perplexity's models endpoint nor models.dev declares `tool_call` for
 * the sonar models, so every row stored `null` for tool support — which reads as
 * "unknown, send tools anyway" everywhere downstream. Sending them is not
 * harmless: the chat-completions endpoint answers `invalid request` (verified
 * against sonar-pro), so the turn fails outright, and the composer's "no tools"
 * chip stayed hidden because it only shows on an explicit `false`, leaving the
 * agent's tools looking available while never firing.
 *
 * Recording it as a capability rather than gating the provider in the chat route
 * keeps the decision per model: inference sits below both the fetcher and
 * models.dev in the resolution order, so the day a Perplexity model declares
 * tool support it overrides this and tools flow with no code change.
 */
function inferPerplexityCapabilities(): ProviderModelCapabilities {
  return {
    ...emptyCapabilities(),
    supportsToolCalling: false,
  };
}

/**
 * Ollama's endpoints report no modalities, and models.dev only covers the
 * `ollama/` namespace — so a locally built or fine-tuned model stored `null` for
 * both. The edit dialog requires at least one input modality, so those rows made
 * the form invalid on open and every save silently failed validation with the
 * message rendered off-screen. Local Ollama models are text-in/text-out, apart
 * from embedding models which produce vectors rather than a modality.
 */
function inferOllamaCapabilities(
  fetched?: FetchedModelCapabilities,
): ProviderModelCapabilities {
  const isEmbeddingModel =
    typeof fetched?.embeddingDimensions === "number" &&
    fetched.embeddingDimensions > 0;

  return {
    ...emptyCapabilities(),
    inputModalities: ["text"],
    outputModalities: isEmbeddingModel ? [] : ["text"],
  };
}

/**
 * Azure deployment names are chosen by the customer, so the id alone often says
 * nothing about the model behind it. The underlying model name settles it: an
 * opaquely-named embedding deployment must still be classified as one, or the
 * vendor entry it resolves to — which lists a "text" output — would make it look
 * generative.
 */
function inferAzureCapabilities(
  modelId: string,
  underlyingModelName?: string | null,
): ProviderModelCapabilities {
  const isEmbedding = [modelId, underlyingModelName].some((name) =>
    name?.toLowerCase().includes("embedding"),
  );
  if (!isEmbedding) {
    return emptyCapabilities();
  }

  return {
    ...emptyCapabilities(),
    inputModalities: ["text"],
    outputModalities: [],
    supportsToolCalling: false,
  };
}

function inferGeminiCapabilities(modelId: string): ProviderModelCapabilities {
  const normalizedModelId = modelId.toLowerCase();

  if (!normalizedModelId.startsWith("gemini-")) {
    return emptyCapabilities();
  }

  if (normalizedModelId.includes("embedding")) {
    return {
      ...emptyCapabilities(),
      inputModalities: ["text"],
      outputModalities: [],
      supportsToolCalling: false,
    };
  }

  if (
    normalizedModelId.includes("live") ||
    normalizedModelId.includes("audio")
  ) {
    return {
      ...emptyCapabilities(),
      inputModalities: ["text", "audio"],
      outputModalities: ["audio"],
      supportsToolCalling: false,
    };
  }

  if (normalizedModelId.includes("image")) {
    return {
      ...emptyCapabilities(),
      inputModalities: ["text", "image"],
      outputModalities: ["image"],
      supportsToolCalling: false,
    };
  }

  return {
    ...emptyCapabilities(),
    inputModalities: ["text"],
    outputModalities: ["text"],
  };
}

function normalizeKnownModelCapabilities(params: {
  provider: SupportedProvider;
  modelId: string;
  capabilities: ProviderModelCapabilities;
}): ProviderModelCapabilities {
  const { provider, modelId, capabilities } = params;
  const normalizedModelId = modelId.toLowerCase();

  if (
    provider === "gemini" &&
    normalizedModelId === "gemini-embedding-2-preview"
  ) {
    return {
      ...capabilities,
      inputModalities: ["text", "image"],
      outputModalities: [],
      supportsToolCalling: false,
    };
  }

  return capabilities;
}

function emptyCapabilities(): ProviderModelCapabilities {
  return {
    description: null,
    contextLength: null,
    outputLength: null,
    inputModalities: null,
    outputModalities: null,
    supportsToolCalling: null,
    promptPricePerToken: null,
    completionPricePerToken: null,
    cacheReadPricePerToken: null,
    cacheWritePricePerToken: null,
  };
}

import type { ModelsDevApiResponse } from "@/clients/models-dev-client";
import logger from "@/logging";
import { ModelModel } from "@/models";
import { resolveDiscoveredModelRegistryEntry } from "@/services/cross-provider-pricing";
import type { Model } from "@/types";

/**
 * Fill in a model the LLM proxy has just recorded for the first time.
 *
 * Sync only ever writes models a provider's own API returned, so a model that
 * only ever arrives through the proxy is never reached by it, and
 * `deleteOrphanedModels` spares proxy-discovered rows by design. Without this
 * the row keeps a null price for its whole life and every request against it is
 * costed at the fabricated default estimate, which is what
 * `interactions.cost`, the cost statistics and the token-cost limits are all
 * computed from.
 *
 * Returns whether anything was written; a model the registry cannot place is
 * left alone rather than guessed at.
 */
export async function enrichDiscoveredModel(params: {
  model: Model;
  modelsDevData: ModelsDevApiResponse;
}): Promise<boolean> {
  const { model, modelsDevData } = params;

  const resolved = resolveDiscoveredModelRegistryEntry({
    provider: model.provider,
    modelId: model.modelId,
    modelsDevData,
  });
  if (!resolved) {
    return false;
  }

  const { prices, metadata } = resolved;
  await ModelModel.applyRegistryCapabilities(model.id, {
    promptPricePerToken: prices?.promptPricePerToken ?? null,
    completionPricePerToken: prices?.completionPricePerToken ?? null,
    cacheReadPricePerToken: prices?.cacheReadPricePerToken ?? null,
    cacheWritePricePerToken: prices?.cacheWritePricePerToken ?? null,
    contextLength: metadata?.contextLength ?? null,
    outputLength: metadata?.outputLength ?? null,
    supportsToolCalling: metadata?.supportsToolCalling ?? null,
  });

  logger.info(
    { provider: model.provider, modelId: model.modelId },
    "Enriched proxy-discovered model from the registry",
  );
  return true;
}

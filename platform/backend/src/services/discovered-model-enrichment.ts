import { PROVIDERS_BILLING_NO_TOKEN_RATE } from "@archestra/shared";
import type { ModelsDevApiResponse } from "@/clients/models-dev-client";
import logger from "@/logging";
import { ModelModel } from "@/models";
import { resolveDiscoveredModelRegistryEntry } from "@/services/cross-provider-pricing";
import { lookupOpenAiPublishedPrices } from "@/services/openai-published-pricing";
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
  // Covers the Codex models the registry omits, and the case where it places
  // the model but publishes no price for it.
  const published = resolved?.prices?.promptPricePerToken
    ? null
    : lookupOpenAiPublishedPrices(model.modelId);
  if (!resolved && !published) {
    return false;
  }

  const { prices, metadata } = resolved ?? { prices: null, metadata: null };
  // A client can name any model on any endpoint, so a vendor model reaches a
  // server the operator runs. Its registry price would be charged for tokens
  // nobody bills — and a stored price outranks the zero-rate rule at read time,
  // so it must never be written rather than corrected later. The context window
  // is whatever that deployment was launched with, which the registry cannot
  // know: entries for one model range over an order of magnitude. What survives
  // describes the model rather than where it is served.
  const selfHosted = PROVIDERS_BILLING_NO_TOKEN_RATE.has(model.provider);
  await ModelModel.applyRegistryCapabilities(model.id, {
    promptPricePerToken: selfHosted
      ? null
      : (prices?.promptPricePerToken ?? published?.promptPricePerToken ?? null),
    completionPricePerToken: selfHosted
      ? null
      : (prices?.completionPricePerToken ??
        published?.completionPricePerToken ??
        null),
    cacheReadPricePerToken: selfHosted
      ? null
      : (prices?.cacheReadPricePerToken ??
        published?.cacheReadPricePerToken ??
        null),
    cacheWritePricePerToken: selfHosted
      ? null
      : (prices?.cacheWritePricePerToken ?? null),
    contextLength: selfHosted ? null : (metadata?.contextLength ?? null),
    outputLength: selfHosted ? null : (metadata?.outputLength ?? null),
    supportsToolCalling: metadata?.supportsToolCalling ?? null,
  });

  logger.info(
    { provider: model.provider, modelId: model.modelId },
    "Enriched proxy-discovered model from the registry",
  );
  return true;
}

import type { SupportedProvider } from "@archestra/shared";
import { registryLookupCandidates } from "./cross-provider-pricing";

/**
 * Per-token prices transcribed from a vendor's own price list. Strings for
 * precision, matching how prices are stored.
 */
export interface VendorPublishedPrices {
  promptPricePerToken: string;
  completionPricePerToken: string;
  cacheReadPricePerToken: string;
}

/**
 * Prices for models the models.dev registry lists without a cost, or omits.
 *
 * A registry gap is not a signal that a model is free: every id here bills per
 * token at a rate its vendor publishes, and each was reaching the fabricated
 * default estimate instead — $50/M against a published $1.25/M for the Codex
 * models, and against $0.15/M for Gemma, a 333× overstatement.
 *
 * Refreshing means re-reading the two pages cited below. Every id is stated
 * outright rather than derived from a base model by stripping a suffix: that
 * predicts the price for `gpt-5.1-codex` and then breaks on
 * `gpt-5.1-codex-mini`, which bills a fifth of what `gpt-5.1` does.
 */
const PUBLISHED_PRICES: Record<
  string,
  { in: number; cachedIn: number; out: number } | undefined
> = {
  // OpenAI, standard tier: https://developers.openai.com/api/docs/pricing
  //
  // A bare id, not a typo: OpenAI lists the ChatGPT-latest alias under this
  // name, priced apart from the `gpt-5*-chat-latest` snapshots.
  "chat-latest": { in: 5, cachedIn: 0.5, out: 30 },
  "gpt-5-chat-latest": { in: 1.25, cachedIn: 0.125, out: 10 },
  "gpt-5-codex": { in: 1.25, cachedIn: 0.125, out: 10 },
  "gpt-5.1-chat-latest": { in: 1.25, cachedIn: 0.125, out: 10 },
  "gpt-5.1-codex": { in: 1.25, cachedIn: 0.125, out: 10 },
  "gpt-5.1-codex-max": { in: 1.25, cachedIn: 0.125, out: 10 },
  "gpt-5.1-codex-mini": { in: 0.25, cachedIn: 0.025, out: 2 },
  "gpt-5.2-codex": { in: 1.75, cachedIn: 0.175, out: 14 },

  // Google, the sole entry under "Gemma Model Pricing":
  // https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing#gemma-model
  //
  // The cache rate is transcribed rather than derived. It is a tenth of the
  // input price where the multiplier Gemini models fall back to is a quarter,
  // so deriving it would bill cache reads at two and a half times the real rate.
  //
  // Gemma is open-weights, so the same name also reaches deployments billing no
  // per-token rate at all. Those are served under their own provider and priced
  // there; this figure is what Google charges to serve it.
  "gemma-4-26b-a4b-it": { in: 0.15, cachedIn: 0.015, out: 0.6 },
};

/**
 * Providers that serve a vendor's own models, so a rate that vendor publishes is
 * the rate being charged.
 *
 * A reseller is excluded: it republishes these models at its own margin, and its
 * registry entry already carries that price.
 */
const PUBLISHING_PROVIDERS = new Set<SupportedProvider>(["openai", "gemini"]);

/**
 * Published prices for a model served by the vendor that makes it, or null when
 * the registry already covers it or nothing is published.
 *
 * Ranks below models.dev in the price ladder, so it can only fill a gap that
 * would otherwise reach the default estimate. A model the registry gains later
 * silently stops consulting this map.
 */
export function resolveVendorPublishedPrices(params: {
  provider: SupportedProvider;
  modelId: string;
}): VendorPublishedPrices | null {
  const { provider, modelId } = params;
  return PUBLISHING_PROVIDERS.has(provider)
    ? lookupVendorPublishedPrices(modelId)
    : null;
}

/**
 * Published prices for a model id, whatever provider it was recorded under.
 *
 * The LLM proxy writes a discovered model under the *endpoint's* provider, so a
 * client naming a Codex model on a Bedrock endpoint produces a `bedrock` row.
 * The price belongs to the model, and a reseller that publishes no rate of its
 * own has nothing better to offer, so the lookup ignores the provider — the
 * same reasoning that lets discovery fall back to a first-party registry entry.
 */
export function lookupVendorPublishedPrices(
  modelId: string,
): VendorPublishedPrices | null {
  const entry = registryLookupCandidates(modelId)
    .map((id) => PUBLISHED_PRICES[id])
    .find((found) => found !== undefined);
  if (!entry) {
    return null;
  }

  return {
    promptPricePerToken: perToken(entry.in),
    completionPricePerToken: perToken(entry.out),
    cacheReadPricePerToken: perToken(entry.cachedIn),
  };
}

/**
 * Model ids this map prices.
 *
 * @public — exported for the test asserting the registry has not caught up;
 * knip --production sees no other consumer.
 */
export const VENDOR_PUBLISHED_PRICE_IDS = Object.keys(PUBLISHED_PRICES);

function perToken(perMillion: number): string {
  return Number.parseFloat((perMillion / 1_000_000).toFixed(12)).toString();
}

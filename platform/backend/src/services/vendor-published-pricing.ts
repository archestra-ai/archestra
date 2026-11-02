import type { SupportedProvider } from "@archestra/shared";
import type { ProviderModelPricing } from "@/types/provider-model-pricing";
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

/**
 * Complete, provider-scoped schedules where the stored flat catalog cannot
 * express a context tier. Exact IDs only: a reseller or a similarly named
 * model must never inherit another service's rates.
 *
 * GitHub Copilot USD/M-token prices verified 2026-10-30:
 * https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 * Refresh by reviewing that table and releasing the updated snapshot. Model
 * refresh does not update this data. Keep short and long rates together so a
 * changed flat catalog cannot be combined with an older surcharge.
 * Null cache write means unpublished, not zero.
 */
type PublishedRates = {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
};
const PUBLISHED_CONTEXT_PRICES: Partial<
  Record<
    SupportedProvider,
    Record<
      string,
      {
        threshold: number;
        short: PublishedRates;
        long: PublishedRates;
      }
    >
  >
> = {
  "github-copilot": {
    "claude-haiku-5.5": {
      threshold: 100000,
      short: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    },
    "gpt-5.6-luna": {
      threshold: 200000,
      short: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
      long: { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
    },
    "gpt-5.6-sol": {
      threshold: 272000,
      short: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
      long: { input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 },
    },
    "gpt-5.6-terra": {
      threshold: 272000,
      short: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
      long: { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
    },
    "gpt-6-astra": {
      threshold: 272000,
      short: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      long: { input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
    },
    "gpt-6-luna": {
      threshold: 272000,
      short: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      long: { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
    },
    "gpt-6-sol": {
      threshold: 272000,
      short: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      long: { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
    },
    "gpt-6.1-sol": {
      threshold: 272000,
      short: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
      long: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
    },
    "gpt-6.1-terra": {
      threshold: 272000,
      short: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
      long: { input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 },
    },
    "grok-4.5": {
      threshold: 200000,
      short: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: null },
      long: { input: 4, output: 12, cacheRead: 1, cacheWrite: null },
    },
    "grok-4.6": {
      threshold: 200000,
      short: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: null },
      long: { input: 4, output: 12, cacheRead: 1, cacheWrite: null },
    },
    "grok-4.7": {
      threshold: 200000,
      short: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: null },
      long: { input: 4, output: 12, cacheRead: 1, cacheWrite: null },
    },
  },
};

/** A published schedule is evaluated at quote time, including raw passthrough. */
export function resolveVendorPublishedPriceSchedule(params: {
  provider: SupportedProvider;
  modelId: string;
}): {
  threshold: number;
  short: ProviderModelPricing;
  long: ProviderModelPricing;
} | null {
  const catalog = PUBLISHED_CONTEXT_PRICES[params.provider];
  const schedule =
    catalog && Object.hasOwn(catalog, params.modelId)
      ? catalog[params.modelId]
      : undefined;
  if (!schedule) return null;
  const convert = (rates: PublishedRates): ProviderModelPricing => ({
    promptPricePerToken: perToken(rates.input),
    completionPricePerToken: perToken(rates.output),
    cacheReadPricePerToken:
      rates.cacheRead === null ? null : perToken(rates.cacheRead),
    cacheWritePricePerToken:
      rates.cacheWrite === null ? null : perToken(rates.cacheWrite),
  });
  return {
    threshold: schedule.threshold,
    short: convert(schedule.short),
    long: convert(schedule.long),
  };
}

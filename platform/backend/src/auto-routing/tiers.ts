import { isDeepStrictEqual } from "node:util";
import { ModelModel } from "@/models";
import { quotedPrices } from "@/services/billable-usage";
import type { Model } from "@/types";
import type { AutoRouter, RouterDocument } from "@/types/auto-routing";

export const TIER_NAMES = ["fast", "normal", "smart"] as const;
type TierName = (typeof TIER_NAMES)[number];
export type TierIndex = 0 | 1 | 2;
export type Trio = readonly [Model, Model, Model];

export const NORMAL_TIER: TierIndex = 1;

/** The trio's prices; the fit blends the two cache-write rates into router-core's `TierSet`. */
export type RouterTierSet = {
  tiers: {
    model_id: string;
    short: RouterTokenPrices;
    long: RouterTokenPrices | null;
  }[];
  long_context_threshold: number | null;
};

/** The configured (fast, normal, smart) models, or why there is no trio. */
export async function loadTrio(
  settings: AutoRouter,
): Promise<{ kind: "ok"; trio: Trio } | { kind: "missing"; tier: TierName }> {
  const ids = [
    settings.fastModelId,
    settings.normalModelId,
    settings.smartModelId,
  ];
  const models = await ModelModel.findByIds(
    ids.filter((id): id is string => id !== null),
  );
  const byId = new Map(models.map((model) => [model.id, model]));
  const [fast, normal, smart] = ids.map((id) =>
    id ? byId.get(id) : undefined,
  );
  if (!fast) return { kind: "missing", tier: "fast" };
  if (!normal) return { kind: "missing", tier: "normal" };
  if (!smart) return { kind: "missing", tier: "smart" };
  return { kind: "ok", trio: [fast, normal, smart] };
}

/**
 * The long-context threshold the tiers share. router-core prices every tier
 * at one threshold, so unequal non-null thresholds cannot be represented.
 */
export function sharedLongContextThreshold(
  models: readonly Parameters<typeof ModelModel.getLongContextThreshold>[0][],
):
  | { kind: "ok"; threshold: number | null }
  | { kind: "mismatched"; thresholds: number[] } {
  const thresholds = [
    ...new Set(
      models.flatMap((model) => {
        const threshold = ModelModel.getLongContextThreshold(model);
        return threshold === null ? [] : [threshold];
      }),
    ),
  ];
  switch (thresholds.length) {
    case 0:
      return { kind: "ok", threshold: null };
    case 1:
      return { kind: "ok", threshold: thresholds[0] };
    default:
      return { kind: "mismatched", thresholds };
  }
}

export class TierThresholdMismatchError extends Error {
  constructor(thresholds: number[]) {
    super(
      `Auto routing tiers have different long-context thresholds (${thresholds.join(", ")}); give every tier with long-context prices the same threshold.`,
    );
  }
}

/**
 * The trio at its current prices: what a plan is
 * fitted for and must still match to be served. Throws
 * `TierThresholdMismatchError` when the tiers do not share a threshold.
 * @public — the plan fit builds its tiers with this; exported for testability
 */
export function tiersFingerprint(trio: Trio): RouterTierSet {
  const shared = sharedLongContextThreshold(trio);
  if (shared.kind === "mismatched")
    throw new TierThresholdMismatchError(shared.thresholds);
  return {
    tiers: trio.map((model) => {
      const threshold = ModelModel.getLongContextThreshold(model);
      return {
        model_id: model.id,
        short: prices(model),
        long: threshold === null ? null : prices(model, threshold + 1),
      };
    }),
    long_context_threshold: shared.threshold,
  };
}

/** A trio without a shared threshold matches no plan. */
export function fingerprintMatches(
  planFingerprint: RouterDocument,
  trio: Trio,
): boolean {
  return (
    sharedLongContextThreshold(trio).kind === "ok" &&
    isDeepStrictEqual(planFingerprint, tiersFingerprint(trio))
  );
}

export type RouterTokenPrices = {
  input: number;
  cache_read: number;
  /** Cache writes with the default TTL; `cache_write_1h` prices the 1h ones. */
  cache_write: number;
  cache_write_1h: number;
  output: number;
};

/** USD per million tokens of `model`, at the long-context rate when `promptTokens` passes its threshold. */
export function prices(model: Model, promptTokens?: number): RouterTokenPrices {
  const pricing = ModelModel.getEffectivePricing(
    model,
    undefined,
    undefined,
    promptTokens,
  );
  const quote = quotedPrices({
    model: model.modelId,
    provider: model.provider,
    pricing,
    instancePriced: false,
  });
  // An unpriced cache direction is not charged by the cost path either.
  const usd = (value: string | null) => Number(value ?? 0);
  return {
    input: usd(pricing.pricePerMillionInput),
    cache_read: usd(pricing.pricePerMillionCacheRead),
    cache_write: usd(pricing.pricePerMillionCacheWrite),
    cache_write_1h: usd(quote.prices.cacheWrite1h),
    output: usd(pricing.pricePerMillionOutput),
  };
}

import { isDeepStrictEqual } from "node:util";
import { ModelModel } from "@/models";
import type { Model } from "@/types";
import type { AutoRoutingSettings, RouterDocument } from "@/types/auto-routing";

export const TIER_NAMES = ["fast", "normal", "smart"] as const;
type TierName = (typeof TIER_NAMES)[number];
export type TierIndex = 0 | 1 | 2;
export type Trio = readonly [Model, Model, Model];

export const NORMAL_TIER: TierIndex = 1;

/** router-core `TierSet` JSON. */
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
  settings: AutoRoutingSettings,
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
 * router-core `TierSet` for the trio at its current prices: what a plan is
 * fitted for and must still match to be served.
 * @public — the plan fit builds its tiers with this; exported for testability
 */
export function tiersFingerprint(trio: Trio): RouterTierSet {
  const thresholds = trio.flatMap((model) =>
    model.longContextThreshold === null ? [] : [model.longContextThreshold],
  );
  return {
    tiers: trio.map((model) => ({
      model_id: model.id,
      short: prices(model),
      long:
        model.longContextThreshold === null
          ? null
          : prices(model, model.longContextThreshold + 1),
    })),
    long_context_threshold: thresholds.length ? Math.min(...thresholds) : null,
  };
}

export function fingerprintMatches(
  planFingerprint: RouterDocument,
  trio: Trio,
): boolean {
  return isDeepStrictEqual(planFingerprint, tiersFingerprint(trio));
}

type RouterTokenPrices = {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
};

function prices(model: Model, promptTokens?: number): RouterTokenPrices {
  const pricing = ModelModel.getEffectivePricing(
    model,
    undefined,
    undefined,
    promptTokens,
  );
  // An unpriced cache direction is not charged by the cost path either.
  const usd = (value: string | null) => Number(value ?? 0);
  return {
    input: usd(pricing.pricePerMillionInput),
    cache_read: usd(pricing.pricePerMillionCacheRead),
    cache_write: usd(pricing.pricePerMillionCacheWrite),
    output: usd(pricing.pricePerMillionOutput),
  };
}

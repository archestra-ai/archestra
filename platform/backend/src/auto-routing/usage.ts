import { ModelModel } from "@/models";
import RoutingUsageModel from "@/models/routing-usage";
import { quotedPrices } from "@/services/billable-usage";
import type { Model } from "@/types";
import type { AutoRoutingUsage } from "@/types/auto-routing-api";
import { loadAutoRouter } from "./settings";
import { prices, type RouterTokenPrices, TIER_NAMES } from "./tiers";

/**
 * What the router routed over the last `days` days: sessions, requests and
 * billed spend per tier, and what the billed requests' tokens would have
 * cost on its current smart model at list price. Subscription-covered
 * requests count as sessions and requests only.
 */
export async function describeRoutedUsage(
  organizationId: string,
  routerId: string,
  days: number,
): Promise<AutoRoutingUsage> {
  const router = await loadAutoRouter(organizationId, routerId);
  const [smart] = router.smartModelId
    ? await ModelModel.findByIds([router.smartModelId])
    : [];
  const threshold = smart ? ModelModel.getLongContextThreshold(smart) : null;
  const rows = await RoutingUsageModel.findRoutedUsage({
    routerId: router.id,
    since: new Date(Date.now() - days * DAY_MS),
    longContextThreshold: threshold,
  });

  const tiers = TIER_NAMES.map((tier, index) => {
    const row = rows.find((candidate) => candidate.tierIndex === index);
    return {
      tier,
      sessions: row?.sessions ?? 0,
      requests: row?.requests ?? 0,
      costUsd: row?.costUsd ?? 0,
    };
  });
  const smartPrices = smart
    ? {
        short: usagePrices(smart),
        long: threshold === null ? null : usagePrices(smart, threshold + 1),
      }
    : null;
  return {
    windowDays: days,
    sessions: sum(tiers.map((tier) => tier.sessions)),
    requests: sum(tiers.map((tier) => tier.requests)),
    costUsd: sum(tiers.map((tier) => tier.costUsd)),
    allSmartCostUsd: smartPrices
      ? sum(
          rows.map(
            (row) =>
              priced(row.short, smartPrices.short) +
              (smartPrices.long ? priced(row.long, smartPrices.long) : 0),
          ),
        )
      : null,
    tiers,
  };
}

// === Internal ===

const DAY_MS = 24 * 60 * 60 * 1000;

type Tokens = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
};

function usagePrices(model: Model, promptTokens?: number) {
  const quote = quotedPrices({
    model: model.modelId,
    provider: model.provider,
    pricing: ModelModel.getEffectivePricing(
      model,
      undefined,
      undefined,
      promptTokens,
    ),
    instancePriced: false,
  });
  return {
    ...prices(model, promptTokens),
    cache_write_1h: Number(quote.prices.cacheWrite1h ?? 0),
  };
}

function priced(
  tokens: Tokens,
  usd: RouterTokenPrices & { cache_write_1h: number },
): number {
  const write1h = Math.min(Math.max(tokens.cacheWrite1h, 0), tokens.cacheWrite);
  return (
    (tokens.input * usd.input +
      tokens.cacheRead * usd.cache_read +
      (tokens.cacheWrite - write1h) * usd.cache_write +
      write1h * usd.cache_write_1h +
      tokens.output * usd.output) /
    1_000_000
  );
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

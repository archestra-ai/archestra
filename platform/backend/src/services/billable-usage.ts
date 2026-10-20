import {
  CACHE_PRICE_MULTIPLIERS,
  type SupportedProvider,
} from "@archestra/shared/model-constants";
import ModelModel from "@/models/model";
import type { UsageView } from "@/types/llm-provider";
import {
  formatMoney,
  moneyUnits,
  type PricedBillingUsage,
  type PricedComponent,
  priceTokens,
  primaryBillingUsage,
  scalePrice,
  sumMoney,
} from "@/utils/billable-usage";

/** Resolve a batch of model prices once, then retain the quote with each charge. */
export async function priceBillingUsage(params: {
  model: string;
  provider: SupportedProvider;
  usage: UsageView;
  mode: PricedBillingUsage["mode"];
}): Promise<PricedBillingUsage> {
  const { provider, usage, model, mode } = params;
  if (
    usage.billingQuote?.model === model &&
    usage.billingQuote.provider === provider &&
    usage.billingQuote.priced.mode === mode
  )
    return usage.billingQuote.priced;
  const breakdown = usage.billingUsage ?? primaryBillingUsage(usage, model);
  const models = await ModelModel.findByProviderAndModelIds(provider, [
    ...new Set(breakdown.components.map((item) => item.model)),
  ]);
  const issues = [...breakdown.issues];
  const components: PricedComponent[] = [];
  for (const component of breakdown.components) {
    const pricing = ModelModel.getEffectivePricing(
      models.get(component.model) ?? null,
      component.model,
      provider,
    );
    const multiplier = CACHE_PRICE_MULTIPLIERS[provider];
    const prices = {
      input: pricing.pricePerMillionInput,
      output: pricing.pricePerMillionOutput,
      cacheRead: pricing.pricePerMillionCacheRead,
      cacheWrite: pricing.pricePerMillionCacheWrite,
      cacheWrite1h:
        pricing.pricePerMillionCacheWrite === null
          ? null
          : multiplier?.write1h && multiplier.write > 0
            ? scalePrice(
                pricing.pricePerMillionCacheWrite,
                BigInt(Math.round(multiplier.write1h * 100)),
                BigInt(Math.round(multiplier.write * 100)),
              )
            : pricing.pricePerMillionCacheWrite,
      source: pricing.source,
    };
    const authoritative =
      usage.providerReportedCost !== undefined &&
      components.length === 0 &&
      breakdown.components.length === 1 &&
      Number.isFinite(usage.providerReportedCost) &&
      usage.providerReportedCost >= 0;
    if (
      !authoritative &&
      pricing.source === "default" &&
      (prices.input !== "0.00" || prices.output !== "0.00")
    ) {
      issues.push("estimated_model_price");
    }
    let cost = "0.0000000000";
    try {
      const missing =
        (component.cacheReadTokens > 0 && prices.cacheRead === null) ||
        (component.cacheWriteTokens > component.cacheWrite1hTokens &&
          prices.cacheWrite === null) ||
        (component.cacheWrite1hTokens > 0 && prices.cacheWrite1h === null);
      if (missing && !authoritative) issues.push("unpriced_usage");
      cost = priceTokens(component, {
        ...prices,
        cacheRead: prices.cacheRead ?? "0",
        cacheWrite: prices.cacheWrite ?? "0",
        cacheWrite1h: prices.cacheWrite1h ?? "0",
      });
    } catch {
      if (!authoritative) issues.push("unpriced_usage");
    }
    components.push({ ...component, provider, prices, cost });
  }
  if (usage.inputTokensEstimated) issues.push("estimated_input_tokens");
  if (usage.providerReportedCost !== undefined) {
    const reported = usage.providerReportedCost;
    if (!Number.isFinite(reported) || reported < 0) {
      issues.push("invalid_provider_cost");
    } else if (components.length === 1) {
      components[0].cost = reported.toFixed(10);
      components[0].prices.source = "provider";
    } else {
      // A total charge cannot supply an authoritative per-model allocation.
      issues.push("unallocated_provider_cost");
      if (components.length) {
        const total = moneyUnits(reported.toFixed(10));
        const weights = components.map((item) => moneyUnits(item.cost));
        const denominator = weights.reduce((sum, item) => sum + item, 0n);
        let remainder = total;
        for (let index = 0; index < components.length; index++) {
          // With no price weights, retain the total on the final component.
          // Allocation remains incomplete, so budgets cannot trust that split.
          const allocated =
            index === components.length - 1
              ? remainder
              : denominator > 0n
                ? (total * weights[index]) / denominator
                : 0n;
          components[index].cost = formatMoney(allocated);
          remainder -= allocated;
        }
      }
    }
  }
  const priced: PricedBillingUsage = {
    version: 1,
    mode,
    status:
      breakdown.status === "complete" && !issues.length
        ? "complete"
        : "incomplete",
    issues: [...new Set(issues)],
    components,
    cost: sumMoney(components.map((item) => item.cost)),
  };
  // Request-scoped memoization keeps later metrics and settlement on this quote.
  usage.billingQuote = { model, provider, priced };
  return priced;
}

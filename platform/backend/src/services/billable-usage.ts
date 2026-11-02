import {
  CACHE_PRICE_MULTIPLIERS,
  type SupportedProvider,
} from "@archestra/shared/model-constants";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import type { UsageView } from "@/types/llm-provider";
import {
  estimateMissingPrices,
  formatMoney,
  moneyUnits,
  type PricedBillingUsage,
  type PricedComponent,
  type PricingQuote,
  priceTokens,
  primaryBillingUsage,
  promptTokens,
  type QuotedPrices,
  scalePrice,
  sumMoney,
} from "@/utils/billable-usage";

/**
 * Resolve every component's prices for one request in a single batch, each at
 * its own prompt size so long-context prices apply per component.
 */
export async function resolvePricingQuote(params: {
  model: string;
  provider: SupportedProvider;
  usage: UsageView;
  providerApiKeyId?: string;
}): Promise<PricingQuote> {
  const { model, provider, usage, providerApiKeyId } = params;
  const breakdown = usage.billingUsage ?? primaryBillingUsage(usage, model);
  const rows = await ModelModel.findByProviderAndModelIds(provider, [
    ...new Set([model, ...breakdown.components.map((item) => item.model)]),
  ]);
  const instancePrices =
    await LlmProviderApiKeyModelLinkModel.findProviderPricing({
      apiKeyId: providerApiKeyId,
      modelIds: [...rows.values()].map((row) => row.id),
    });
  const quote = (modelId: string, size: number): QuotedPrices => {
    const row = rows.get(modelId);
    const projected = row
      ? ModelModel.withProviderPricing(row, [
          instancePrices.get(row.id) ?? null,
        ])
      : null;
    const pricing = ModelModel.getEffectivePricing(
      projected,
      modelId,
      provider,
      size,
    );
    const quoted = quotedPrices({
      model: modelId,
      provider,
      pricing,
      instancePriced:
        projected?.providerPricing !== undefined &&
        projected.providerPricing !== "conflicting",
    });
    if (projected?.providerPricing === undefined) return quoted;
    const catalog = ModelModel.getEffectivePricing(
      row ?? null,
      modelId,
      provider,
      size,
    );
    return {
      ...quoted,
      catalog: {
        input: catalog.pricePerMillionInput,
        output: catalog.pricePerMillionOutput,
      },
    };
  };
  return {
    model,
    provider,
    providerApiKeyId,
    request: quote(model, promptTokens(usage)),
    components: new Map(
      breakdown.components.map((item) => [
        item.id,
        quote(item.model, promptTokens(item)),
      ]),
    ),
  };
}

/** Resolved per-million prices as a quote; the 1h write rate derives from the 5m one. */
export function quotedPrices(params: {
  model: string;
  provider: SupportedProvider;
  pricing: ReturnType<typeof ModelModel.getEffectivePricing>;
  instancePriced: boolean;
}): QuotedPrices {
  const { pricing } = params;
  const multiplier = CACHE_PRICE_MULTIPLIERS[params.provider];
  return {
    model: params.model,
    prices: {
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
    },
    cacheSource: pricing.cacheSource,
    instancePriced: params.instancePriced,
  };
}

/** The request's quote, resolved once and retained on its usage snapshot. */
async function quoteUsagePricing(params: {
  model: string;
  provider: SupportedProvider;
  usage: UsageView;
  providerApiKeyId?: string;
}): Promise<PricingQuote> {
  const memo = params.usage.billingQuote?.pricing;
  if (
    memo?.model === params.model &&
    memo.provider === params.provider &&
    memo.providerApiKeyId === params.providerApiKeyId
  )
    return memo;
  const pricing = await resolvePricingQuote(params);
  params.usage.billingQuote = { pricing };
  return pricing;
}

/** Price the request's billable components from its quote. */
export async function priceBillingUsage(params: {
  model: string;
  provider: SupportedProvider;
  usage: UsageView;
  mode: PricedBillingUsage["mode"];
  providerApiKeyId?: string;
}): Promise<PricedBillingUsage> {
  const { provider, usage, model, mode } = params;
  const pricing = await quoteUsagePricing(params);
  const memo = usage.billingQuote;
  if (memo?.pricing === pricing && memo.priced?.mode === mode)
    return memo.priced;
  const breakdown = usage.billingUsage ?? primaryBillingUsage(usage, model);
  const issues = [...breakdown.issues];
  const components: PricedComponent[] = [];
  for (const component of breakdown.components) {
    const quoted = pricing.components.get(component.id);
    if (!quoted) throw new Error("Billing component missing from its quote");
    const prices = { ...quoted.prices };
    const authoritative =
      usage.providerReportedCost !== undefined &&
      components.length === 0 &&
      breakdown.components.length === 1 &&
      Number.isFinite(usage.providerReportedCost) &&
      usage.providerReportedCost >= 0;
    if (
      !authoritative &&
      prices.source === "default" &&
      (prices.input !== "0.00" || prices.output !== "0.00")
    ) {
      issues.push("estimated_model_price");
    }
    // A missing rate is estimated, never left unpriced: an unpriced request
    // would leave its budgets unable to say what was spent.
    const estimate = estimateMissingPrices({
      usage: component,
      prices,
      provider,
      fallback: quoted.catalog,
    });
    if (!authoritative && estimate.model) issues.push("estimated_model_price");
    if (!authoritative && estimate.cache) issues.push("estimated_cache_price");
    let cost = "0.0000000000";
    try {
      cost = priceTokens(component, estimate.prices);
    } catch {
      if (!authoritative) issues.push("invalid_token_count");
    }
    // The receipt keeps the rates that were known; the estimate is in the cost.
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
  usage.billingQuote = { pricing, priced };
  return priced;
}

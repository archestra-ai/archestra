import {
  CACHE_PRICE_MULTIPLIERS,
  type SupportedProvider,
} from "@archestra/shared/model-constants";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import type { UsageView } from "@/types/llm-provider";
import {
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
    return quotedPrices({
      model: modelId,
      provider,
      pricing,
      instancePriced:
        projected?.providerPricing !== undefined &&
        projected.providerPricing !== "conflicting",
    });
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
export async function quoteUsagePricing(params: {
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
    let cost = "0.0000000000";
    try {
      const missing =
        (component.inputTokens > 0 && prices.input === null) ||
        (component.outputTokens > 0 && prices.output === null) ||
        (component.cacheReadTokens > 0 && prices.cacheRead === null) ||
        (component.cacheWriteTokens > component.cacheWrite1hTokens &&
          prices.cacheWrite === null) ||
        (component.cacheWrite1hTokens > 0 && prices.cacheWrite1h === null);
      if (missing && !authoritative) issues.push("unpriced_usage");
      cost = priceTokens(component, {
        ...prices,
        input: prices.input ?? "0",
        output: prices.output ?? "0",
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
  usage.billingQuote = { pricing, priced };
  return priced;
}

import {
  CACHE_PRICE_MULTIPLIERS,
  type SupportedProvider,
} from "@archestra/shared";
import { ModelModel } from "@/models";
import type { ProviderMessage, Tokenizer } from "@/tokenizers";
import type { CommonMcpToolDefinition } from "@/types";

/**
 * Estimate token count for tool definitions by serializing them
 * and using the provider-specific tokenizer for accurate counting.
 */
export function estimateToolTokens(
  tools: CommonMcpToolDefinition[],
  tokenizer: Tokenizer,
): number {
  if (tools.length === 0) return 0;
  const serialized = tools
    .map((t) => {
      let text = t.name;
      if (t.description) text += ` ${t.description}`;
      if (t.inputSchema) text += ` ${JSON.stringify(t.inputSchema)}`;
      return text;
    })
    .join(" ");
  return tokenizer.countTokens({
    role: "user",
    content: serialized,
  } as ProviderMessage);
}

interface CacheTokenCounts {
  readTokens?: number;
  writeTokens?: number;
  /** Portion of writeTokens written at the 1-hour TTL (billed at write1h, the rest at write). */
  write1hTokens?: number;
}

/**
 * Factor relating the 1-hour cache-write price to the default (5-minute) one for
 * a provider. The 5m write price is the configurable/synced value; the 1h price
 * is derived from it. Returns 1 when the provider has no distinct 1h tier.
 */
function cacheWrite1hFactor(provider: SupportedProvider): number {
  const mult = CACHE_PRICE_MULTIPLIERS[provider];
  if (!mult || !mult.write1h || mult.write <= 0) {
    return 1;
  }
  return mult.write1h / mult.write;
}

/** Parse a per-million price string, treating null/unpriced as zero cost. */
function parsePriceOrZero(price: string | null): number {
  return price == null ? 0 : Number.parseFloat(price);
}

/**
 * Calculate the all-in cost for token usage based on model pricing (input +
 * output + cache read + cache write). Uses provider to disambiguate models with
 * the same name across providers. Returns undefined when there is no usage at
 * all (so a fully-cached request — inputTokens 0 but real cache/output cost —
 * is still costed).
 */
export async function calculateCost(
  model: string,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
  provider: SupportedProvider,
  cacheTokens?: CacheTokenCounts,
): Promise<number | undefined> {
  const readTokens = cacheTokens?.readTokens ?? 0;
  const writeTokens = cacheTokens?.writeTokens ?? 0;
  if (!inputTokens && !outputTokens && !readTokens && !writeTokens) {
    return undefined;
  }

  const model_entry = await ModelModel.findByProviderAndModelId(
    provider,
    model,
  );
  const pricing = ModelModel.getEffectivePricing(model_entry, model, provider);
  const priceIn = Number.parseFloat(pricing.pricePerMillionInput);
  const priceOut = Number.parseFloat(pricing.pricePerMillionOutput);
  // Resolved cache prices (explicit synced/custom, else multiplier-derived).
  // Null when the provider has no cache pricing model — treat as zero so cache
  // tokens add nothing rather than fabricating a cost.
  const cacheReadPrice = parsePriceOrZero(pricing.pricePerMillionCacheRead);
  const cacheWrite5mPrice = parsePriceOrZero(pricing.pricePerMillionCacheWrite);
  const cacheWrite1hPrice = cacheWrite5mPrice * cacheWrite1hFactor(provider);

  // Cache writes are billed per TTL: 1h costs more than the 5m default.
  const write1h = Math.min(
    Math.max(cacheTokens?.write1hTokens ?? 0, 0),
    writeTokens,
  );
  const write5m = writeTokens - write1h;

  return (
    ((inputTokens ?? 0) / 1_000_000) * priceIn +
    ((outputTokens ?? 0) / 1_000_000) * priceOut +
    (readTokens / 1_000_000) * cacheReadPrice +
    (write5m / 1_000_000) * cacheWrite5mPrice +
    (write1h / 1_000_000) * cacheWrite1hPrice
  );
}

/**
 * Cache cost breakdown for the interaction record / observability:
 *  - `cacheCost`: what the cache read+write tokens actually cost.
 *  - `cacheSavings`: net amount caching saved vs paying full input price for
 *    those tokens — cache reads save `(1 - readMult)`, cache writes cost an
 *    extra `(writeMult - 1)`, so net = readSavings - writeSurcharge. May be
 *    negative on cache-write-heavy requests.
 *  - `cacheReadSavings`: gross amount saved by cache reads alone (always >= 0).
 *    Exposed separately because Prometheus counters cannot take negative
 *    increments, so the metrics layer reports this monotonic read-side savings.
 * Returns undefined when there are no cache tokens.
 */
export async function calculateCacheCost(
  model: string,
  provider: SupportedProvider,
  readTokens: number,
  writeTokens: number,
  /** Portion of writeTokens written at the 1-hour TTL (the rest is costed at the 5m rate). */
  write1hTokens = 0,
): Promise<
  | { cacheCost: number; cacheSavings: number; cacheReadSavings: number }
  | undefined
> {
  if (!readTokens && !writeTokens) {
    return undefined;
  }
  const model_entry = await ModelModel.findByProviderAndModelId(
    provider,
    model,
  );
  const pricing = ModelModel.getEffectivePricing(model_entry, model, provider);
  if (pricing.cacheSource == null) {
    // Provider has no cache pricing model; don't fabricate cost/savings.
    return undefined;
  }
  // Each direction is costed only when its price is known. A direction with a
  // known zero price (e.g. providers that don't charge for cache writes) still
  // contributes; a genuinely unpriced (null) direction is skipped so we neither
  // claim its cost nor fabricate savings for it.
  const priceIn = Number.parseFloat(pricing.pricePerMillionInput);
  const cacheReadPrice =
    pricing.pricePerMillionCacheRead != null
      ? Number.parseFloat(pricing.pricePerMillionCacheRead)
      : null;
  const cacheWrite5mPrice =
    pricing.pricePerMillionCacheWrite != null
      ? Number.parseFloat(pricing.pricePerMillionCacheWrite)
      : null;

  // Split writes by TTL: 1h is billed at a higher surcharge than the 5m default.
  const write1h = Math.min(Math.max(write1hTokens, 0), writeTokens);
  const write5m = writeTokens - write1h;

  let cacheCost = 0;
  let cacheReadSavings = 0;
  let writeSurcharge = 0;

  if (cacheReadPrice != null) {
    const readActual = (readTokens / 1_000_000) * cacheReadPrice;
    cacheCost += readActual;
    // Read saves the difference vs. paying the full input price (always >= 0).
    cacheReadSavings = (readTokens / 1_000_000) * priceIn - readActual;
  }

  if (cacheWrite5mPrice != null) {
    const cacheWrite1hPrice = cacheWrite5mPrice * cacheWrite1hFactor(provider);
    const write5mActual = (write5m / 1_000_000) * cacheWrite5mPrice;
    const write1hActual = (write1h / 1_000_000) * cacheWrite1hPrice;
    cacheCost += write5mActual + write1hActual;
    // Cache writes cost extra vs. the input price; this surcharge eats savings.
    writeSurcharge =
      write5mActual -
      (write5m / 1_000_000) * priceIn +
      (write1hActual - (write1h / 1_000_000) * priceIn);
  }

  const cacheSavings = cacheReadSavings - writeSurcharge;

  return { cacheCost, cacheSavings, cacheReadSavings };
}

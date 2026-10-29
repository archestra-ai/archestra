import type { SupportedProvider } from "@archestra/shared";
import type ModelModel from "@/models/model";
import { quotedPrices, resolvePricingQuote } from "@/services/billable-usage";
import type { ProviderMessage, Tokenizer } from "@/tokenizers";
import type { CommonMcpToolDefinition } from "@/types";
import type { QuotedPrices } from "@/utils/billable-usage";

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
  providerApiKeyId?: string;
  readTokens?: number;
  writeTokens?: number;
  /** Portion of writeTokens written at the 1-hour TTL (billed at write1h, the rest at write). */
  write1hTokens?: number;
}

/** Resolved per-million prices, as returned by `ModelModel.getEffectivePricing`. */
type ResolvedPricing = ReturnType<typeof ModelModel.getEffectivePricing>;

/** One request's token usage, in the shape the interaction row stores it. */
interface TokenUsage {
  /** Uncached input tokens. */
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  readTokens?: number | null;
  writeTokens?: number | null;
  /** Portion of writeTokens written at the 1-hour TTL. */
  write1hTokens?: number | null;
}

interface CostTokens {
  inputTokens: number;
  outputTokens: number;
  readTokens: number;
  writeTokens: number;
  write1hTokens: number;
}

/** Parse a per-million price string, treating null/unpriced as zero cost. */
function parsePriceOrZero(price: string | null): number {
  return price == null ? 0 : Number.parseFloat(price);
}

function splitWrites(tokens: CostTokens) {
  const write1h = Math.min(
    Math.max(tokens.write1hTokens, 0),
    tokens.writeTokens,
  );
  return { write1h, write5m: tokens.writeTokens - write1h };
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
  const tokens = {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    readTokens: cacheTokens?.readTokens ?? 0,
    writeTokens: cacheTokens?.writeTokens ?? 0,
    write1hTokens: cacheTokens?.write1hTokens ?? 0,
  };
  if (
    !tokens.inputTokens &&
    !tokens.outputTokens &&
    !tokens.readTokens &&
    !tokens.writeTokens
  ) {
    return undefined;
  }
  const quoted = await quoteModel(
    model,
    provider,
    tokens,
    cacheTokens?.providerApiKeyId,
  );
  return costFromQuote(quoted, tokens);
}

/** The cache cost breakdown (see {@link cacheCostFromQuote}) at the model's current prices. */
export async function calculateCacheCost(
  model: string,
  provider: SupportedProvider,
  readTokens: number,
  writeTokens: number,
  /** Portion of writeTokens written at the 1-hour TTL (the rest is costed at the 5m rate). */
  write1hTokens = 0,
  providerApiKeyId?: string,
): Promise<CacheCostBreakdown | undefined> {
  const tokens = {
    inputTokens: 0,
    outputTokens: 0,
    readTokens,
    writeTokens,
    write1hTokens,
  };
  if (!readTokens && !writeTokens) return undefined;
  const quoted = await quoteModel(model, provider, tokens, providerApiKeyId);
  return cacheCostFromQuote(quoted, tokens);
}

/** The all-in cost of `tokens` at already-quoted prices. */
export function costFromQuote(
  quoted: QuotedPrices,
  tokens: CostTokens,
): number | undefined {
  const { inputTokens, outputTokens, readTokens, writeTokens } = tokens;
  if (!inputTokens && !outputTokens && !readTokens && !writeTokens) {
    return undefined;
  }
  const { prices } = quoted;
  // A LiteLLM route may serve any vendor: OpenAI cache multipliers and a
  // generic base estimate cannot supply a price the instance did not publish.
  if (
    quoted.instancePriced &&
    ((inputTokens && prices.input === null) ||
      (outputTokens && prices.output === null) ||
      (readTokens && prices.cacheRead === null) ||
      (writeTokens && prices.cacheWrite === null))
  )
    return undefined;
  // Null cache prices mean the provider has no cache pricing model — treat as
  // zero so cache tokens add nothing rather than fabricating a cost.
  const { write1h, write5m } = splitWrites(tokens);
  return (
    (inputTokens / 1_000_000) * parsePriceOrZero(prices.input) +
    (outputTokens / 1_000_000) * parsePriceOrZero(prices.output) +
    (readTokens / 1_000_000) * parsePriceOrZero(prices.cacheRead) +
    (write5m / 1_000_000) * parsePriceOrZero(prices.cacheWrite) +
    (write1h / 1_000_000) * parsePriceOrZero(prices.cacheWrite1h)
  );
}

interface CacheCostBreakdown {
  cacheCost: number;
  cacheSavings: number;
  cacheReadSavings: number;
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
 * Undefined when there are no cache tokens. Priced at the request's quote.
 */
export function cacheCostFromQuote(
  quoted: QuotedPrices,
  tokens: CostTokens,
): CacheCostBreakdown | undefined {
  const { readTokens, writeTokens } = tokens;
  if (!readTokens && !writeTokens) {
    return undefined;
  }
  const { prices } = quoted;
  if (
    quoted.instancePriced &&
    (prices.input === null ||
      (readTokens && prices.cacheRead === null) ||
      (writeTokens && prices.cacheWrite === null))
  )
    return undefined;
  if (quoted.cacheSource == null) {
    // Provider has no cache pricing model; don't fabricate cost/savings.
    return undefined;
  }
  // Each direction is costed only when its price is known. A direction with a
  // known zero price (e.g. providers that don't charge for cache writes) still
  // contributes; a genuinely unpriced (null) direction is skipped so we neither
  // claim its cost nor fabricate savings for it.
  const priceIn = parsePriceOrZero(prices.input);
  const { write1h, write5m } = splitWrites(tokens);

  let cacheCost = 0;
  let cacheReadSavings = 0;
  let writeSurcharge = 0;

  if (prices.cacheRead != null) {
    const readActual = (readTokens / 1_000_000) * Number(prices.cacheRead);
    cacheCost += readActual;
    // Read saves the difference vs. paying the full input price (always >= 0).
    cacheReadSavings = (readTokens / 1_000_000) * priceIn - readActual;
  }

  if (prices.cacheWrite != null) {
    const write5mActual = (write5m / 1_000_000) * Number(prices.cacheWrite);
    const write1hActual =
      (write1h / 1_000_000) * parsePriceOrZero(prices.cacheWrite1h);
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

/**
 * The all-in cost of one request's usage at the given resolved prices. The
 * cost backfill and its preview price through here, on the write path's
 * arithmetic, so a recomputed cost matches what the proxy would record.
 */
export function priceTokenUsage(params: {
  pricing: ResolvedPricing;
  provider: SupportedProvider;
  usage: TokenUsage;
}): number | undefined {
  return costFromQuote(quoteResolved(params), costTokens(params.usage));
}

/** The cache cost breakdown at the given resolved prices; see {@link priceTokenUsage}. */
export function priceCacheUsage(params: {
  pricing: ResolvedPricing;
  provider: SupportedProvider;
  usage: Pick<TokenUsage, "readTokens" | "writeTokens" | "write1hTokens">;
}): CacheCostBreakdown | undefined {
  return cacheCostFromQuote(
    quoteResolved(params),
    costTokens({ inputTokens: 0, outputTokens: 0, ...params.usage }),
  );
}

function quoteResolved(params: {
  pricing: ResolvedPricing;
  provider: SupportedProvider;
}): QuotedPrices {
  return quotedPrices({
    model: "",
    provider: params.provider,
    pricing: params.pricing,
    instancePriced: false,
  });
}

function costTokens(usage: TokenUsage): CostTokens {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    readTokens: usage.readTokens ?? 0,
    writeTokens: usage.writeTokens ?? 0,
    write1hTokens: usage.write1hTokens ?? 0,
  };
}

async function quoteModel(
  model: string,
  provider: SupportedProvider,
  tokens: CostTokens,
  providerApiKeyId?: string,
): Promise<QuotedPrices> {
  const quote = await resolvePricingQuote({
    model,
    provider,
    providerApiKeyId,
    usage: {
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheReadTokens: tokens.readTokens,
      cacheWriteTokens: tokens.writeTokens,
      cacheWrite1hTokens: tokens.write1hTokens,
    },
  });
  return quote.request;
}

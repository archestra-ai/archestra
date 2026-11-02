import {
  CACHE_PRICE_MULTIPLIERS,
  type SupportedProvider,
} from "@archestra/shared/model-constants";
import type { UsageView } from "@/types/llm-provider";

export interface BillingAttribution {
  organizationId: string;
  environmentId: string | null;
  entities: {
    entityType: import("@/types/limit").LimitEntityType;
    entityId: string;
  }[];
}

interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
}

interface BillableComponent extends UsageTokens {
  /** Position in the final provider snapshot, not a hash of the token counts. */
  id: string;
  model: string;
  kind: "message" | "advisor_message" | "compaction";
}

export interface BillingUsage {
  version: 1;
  status: "complete" | "incomplete";
  issues: string[];
  components: BillableComponent[];
}

export interface TokenPrices {
  input: string | null;
  output: string | null;
  cacheRead: string | null;
  cacheWrite: string | null;
  cacheWrite1h: string | null;
  source: string;
}

export interface PricedComponent extends BillableComponent {
  provider: SupportedProvider;
  prices: TokenPrices;
  cost: string;
}

/** One model's rates at one prompt size, resolved with the catalog precedence. */
export interface QuotedPrices {
  model: string;
  prices: TokenPrices;
  cacheSource: import("@/types/model").PriceSource | null;
  /** A selected provider instance published this model's rates; rates it omits stay unknown. */
  instancePriced: boolean;
  /**
   * The model's own catalog rates, set when an instance price applies: they
   * estimate an input or output rate that the instance did not publish.
   */
  catalog?: Pick<TokenPrices, "input" | "output">;
}

/** Request-scoped quote shared by cost, cache cost, savings and billable usage. */
export interface PricingQuote {
  model: string;
  provider: SupportedProvider;
  providerApiKeyId?: string;
  /** The request model at the top-level usage's prompt size. */
  request: QuotedPrices;
  /** Billable components by id, each at its own prompt size. */
  components: ReadonlyMap<string, QuotedPrices>;
}

/** The size that selects long-context prices; 1h writes are part of cache writes. */
export function promptTokens(usage: {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number {
  return (
    usage.inputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

export interface PricedBillingUsage {
  version: 1;
  /**
   * Every new receipt is `enforce`: it is charged to its budgets. Receipts
   * from releases where settlement was optional can also read `shadow`
   * (recorded, never charged) or `off`; readers count only `enforce`.
   */
  mode: "off" | "shadow" | "enforce";
  status: "complete" | "incomplete";
  issues: string[];
  components: PricedComponent[];
  cost: string;
}

export function scalePrice(
  value: string,
  numerator: bigint,
  denominator: bigint,
): string {
  const units =
    (decimal(value, 10) * numerator + denominator / 2n) / denominator;
  return formatMoney(units);
}

/** Merge cumulative snapshots without adding counts or erasing omitted fields. */
export function mergeAnthropicUsage(
  previous: Record<string, unknown>,
  next: unknown,
): Record<string, unknown> {
  const result = { ...previous };
  for (const [key, value] of Object.entries(record(next))) {
    if (value === null || value === undefined) continue;
    result[key] =
      key === "cache_creation" &&
      typeof value === "object" &&
      !Array.isArray(value)
        ? mergeAnthropicUsage(record(previous[key]), value)
        : value;
  }
  return result;
}

/**
 * Anthropic's iteration array is a complete billing breakdown. The top-level
 * totals describe the executor and must not be added to those iterations.
 */
export function normalizeAnthropicUsage(
  raw: unknown,
  model: string,
): UsageView {
  const usage = record(raw);
  const issues: string[] = [];
  const primary = tokens(usage, issues);
  const components: BillableComponent[] = [];
  const iterations = usage.iterations;
  if (iterations === undefined || iterations === null) {
    components.push({ id: "primary", model, kind: "message", ...primary });
  } else if (!Array.isArray(iterations) || iterations.length === 0) {
    issues.push("invalid_iterations");
    components.push({ id: "primary", model, kind: "message", ...primary });
  } else {
    for (const [index, value] of iterations.entries()) {
      const item = record(value);
      const kind = item.type;
      if (
        kind !== "message" &&
        kind !== "advisor_message" &&
        kind !== "compaction"
      ) {
        issues.push("unsupported_iteration");
        continue;
      }
      const itemModel =
        typeof item.model === "string" && item.model.length > 0
          ? item.model
          : kind === "advisor_message"
            ? null
            : model;
      if (!itemModel) {
        issues.push("missing_advisor_model");
        continue;
      }
      components.push({
        id: `iteration:${index}`,
        model: itemModel,
        kind,
        ...tokens(item, issues),
      });
    }
    const executor = components.filter((item) => item.kind === "message");
    for (const field of TOKEN_FIELDS) {
      if (
        executor.reduce((sum, item) => sum + item[field], 0) !== primary[field]
      ) {
        issues.push("executor_usage_mismatch");
        break;
      }
    }
  }
  return {
    ...primary,
    ...((iterations !== undefined && iterations !== null) || issues.length
      ? {
          billingUsage: {
            version: 1,
            status: issues.length
              ? ("incomplete" as const)
              : ("complete" as const),
            issues: [...new Set(issues)],
            components,
          },
        }
      : {}),
  };
}

/** A provider without a breakdown has one primary billable component. */
export function primaryBillingUsage(
  usage: UsageView,
  model: string,
): BillingUsage {
  return {
    version: 1,
    status: "complete",
    issues: [],
    components: [
      {
        id: "primary",
        model,
        kind: "message",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        cacheWrite1hTokens: usage.cacheWrite1hTokens ?? 0,
      },
    ],
  };
}

/** Parse a nonnegative charge; use formatMoney for signed differences. */
export function moneyUnits(value: string): bigint {
  return decimal(value, 10);
}

export function formatMoney(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / MONEY_SCALE}.${String(absolute % MONEY_SCALE).padStart(10, "0")}`;
}

export function sumMoney(values: string[]): string {
  return formatMoney(
    values.reduce((sum, value) => sum + moneyUnits(value), 0n),
  );
}

/**
 * Receipt findings that only describe the prices a charge was made at.
 * `unpriced_usage` is what older releases recorded for a missing price.
 */
export const PRICE_ISSUES = new Set([
  "estimated_model_price",
  "estimated_cache_price",
  "unpriced_usage",
]);

/**
 * Whether part of a receipt's charge was estimated for a missing price. Other
 * findings, such as a stream the client cut short, do not mark a budget: no
 * price would change them.
 */
export function hasEstimatedPrice(usage: { issues: string[] }): boolean {
  return usage.issues.some((issue) => PRICE_ISSUES.has(issue));
}

/**
 * Cache rates, as multiples of input, for a provider without its own: a read
 * at half the input rate, between the cheapest published discount (0.1) and
 * none (1), and writes at the input rate, since write surcharges are an
 * Anthropic and Bedrock rule.
 */
const DEFAULT_CACHE_ESTIMATE = { read: 0.5, write: 1, write1h: 1 };

/**
 * Fill every rate that a billed token count needs but the quote lacks, so a
 * request is always charged and never blocks a budget for being unpriced.
 *
 * - Input and output take the model's own catalog rate (`fallback`), which a
 *   per-key provider price can leave unpublished.
 * - Cache rates derive from the input rate: by the provider's own cache
 *   multipliers when it has them, otherwise by `DEFAULT_CACHE_ESTIMATE`. A
 *   model whose input is free stays free.
 *
 * `model` and `cache` report which kind of rate was estimated for tokens the
 * request used. A free rate derived from a free one is exact and not
 * reported; a rate missing everywhere is charged at zero and reported.
 */
export function estimateMissingPrices(params: {
  usage: UsageTokens;
  prices: TokenPrices;
  provider: SupportedProvider;
  fallback?: Pick<TokenPrices, "input" | "output"> | null;
}): { prices: TokenPrices; model: boolean; cache: boolean } {
  const { usage, fallback } = params;
  const multiplier =
    CACHE_PRICE_MULTIPLIERS[params.provider] ?? DEFAULT_CACHE_ESTIMATE;
  const prices = { ...params.prices };
  let model = false;
  let cache = false;
  const positive = (value: string | null) =>
    value !== null && moneyUnits(value) > 0n;
  for (const [key, count] of [
    ["input", usage.inputTokens],
    ["output", usage.outputTokens],
  ] as const) {
    if (prices[key] !== null) continue;
    // No rate anywhere: charge nothing rather than invent one, and say so.
    prices[key] = fallback?.[key] ?? "0";
    if (count > 0 && (fallback?.[key] == null || positive(prices[key])))
      model = true;
  }
  const inputKnown = params.prices.input !== null || fallback?.input != null;
  const input = prices.input ?? "0";
  for (const [key, count, factor] of [
    ["cacheRead", usage.cacheReadTokens, multiplier.read],
    [
      "cacheWrite",
      usage.cacheWriteTokens - usage.cacheWrite1hTokens,
      multiplier.write,
    ],
    [
      "cacheWrite1h",
      usage.cacheWrite1hTokens,
      multiplier.write1h ?? multiplier.write,
    ],
  ] as const) {
    if (prices[key] !== null) continue;
    prices[key] = scalePrice(input, BigInt(Math.round(factor * 100)), 100n);
    if (count <= 0) continue;
    if (!inputKnown) model = true;
    else if (positive(input)) cache = true;
  }
  return { prices, model, cache };
}

/** Round once per component, half up, after summing all token categories. */
export function priceTokens(usage: UsageTokens, prices: TokenPrices): string {
  const counts = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens - usage.cacheWrite1hTokens,
    usage.cacheWrite1hTokens,
  ];
  const rates = [
    prices.input,
    prices.output,
    prices.cacheRead,
    prices.cacheWrite,
    prices.cacheWrite1h,
  ];
  let numerator = 0n;
  for (const [index, count] of counts.entries()) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Invalid billable token count");
    }
    if (count > 0 && rates[index] === null) {
      throw new Error("Missing billable token price");
    }
    numerator += BigInt(count) * decimal(rates[index] ?? "0", 16);
  }
  // Rates have 16 decimal places per million; USD has 10 decimal places.
  const divisor = 1_000_000_000_000n;
  return formatMoney((numerator + divisor / 2n) / divisor);
}

/**
 * Cache charges and avoided uncached-input charges, from the same quote.
 * Savings can be negative when cache writes cost more than uncached input.
 *
 * A direction counts only when its rate is known: an unpriced direction, even
 * one the request was charged an estimate for, adds no cache cost and no
 * savings, so the figures never claim more than the prices say.
 */
export function componentCacheCosts(component: PricedComponent) {
  const { prices } = component;
  // Token counts that cannot be priced have no cache figures either.
  const counts = [
    component.cacheReadTokens,
    component.cacheWriteTokens - component.cacheWrite1hTokens,
    component.cacheWrite1hTokens,
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0))
    return { cacheCost: 0, cacheSavings: 0, cacheReadSavings: 0 };
  const none: UsageTokens = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
  };
  const free: TokenPrices = {
    input: "0",
    output: "0",
    cacheRead: "0",
    cacheWrite: "0",
    cacheWrite1h: "0",
    source: prices.source,
  };
  const units = (usage: Partial<UsageTokens>, rates: Partial<TokenPrices>) =>
    moneyUnits(priceTokens({ ...none, ...usage }, { ...free, ...rates }));
  const read = component.cacheReadTokens;
  const writes = component.cacheWriteTokens;
  const readCost =
    prices.cacheRead === null
      ? null
      : units({ cacheReadTokens: read }, { cacheRead: prices.cacheRead });
  const writeCost =
    prices.cacheWrite === null
      ? null
      : units(
          {
            cacheWriteTokens: writes,
            cacheWrite1hTokens: component.cacheWrite1hTokens,
          },
          {
            cacheWrite: prices.cacheWrite,
            cacheWrite1h: prices.cacheWrite1h ?? "0",
          },
        );
  const cacheCost = (readCost ?? 0n) + (writeCost ?? 0n);
  if (prices.input === null)
    return {
      cacheCost: Number(formatMoney(cacheCost)),
      cacheSavings: 0,
      cacheReadSavings: 0,
    };
  const uncached = (tokens: number) =>
    units({ inputTokens: tokens }, { input: prices.input });
  const readSavings = readCost === null ? 0n : uncached(read) - readCost;
  const writeSurcharge = writeCost === null ? 0n : writeCost - uncached(writes);
  return {
    cacheCost: Number(formatMoney(cacheCost)),
    cacheSavings: Number(formatMoney(readSavings - writeSurcharge)),
    cacheReadSavings: Number(formatMoney(readSavings)),
  };
}

const MONEY_SCALE = 10_000_000_000n;
const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheWrite1hTokens",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(usage: Record<string, unknown>, issues: string[]): UsageTokens {
  const read = (key: string, optional = false) => {
    const value = usage[key];
    if (optional && (value === undefined || value === null)) return 0;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      issues.push("invalid_token_count");
      return 0;
    }
    return value;
  };
  const cacheWriteTokens = read("cache_creation_input_tokens", true);
  if (
    usage.cache_creation != null &&
    (typeof usage.cache_creation !== "object" ||
      Array.isArray(usage.cache_creation))
  )
    issues.push("invalid_cache_split");
  const split = record(usage.cache_creation);
  const oneHour = split.ephemeral_1h_input_tokens ?? 0;
  const validSplit =
    typeof oneHour === "number" &&
    Number.isSafeInteger(oneHour) &&
    oneHour >= 0 &&
    oneHour <= cacheWriteTokens;
  const fiveMinute = split.ephemeral_5m_input_tokens;
  if (
    fiveMinute != null &&
    (typeof fiveMinute !== "number" ||
      !Number.isSafeInteger(fiveMinute) ||
      fiveMinute < 0 ||
      fiveMinute + Number(oneHour) !== cacheWriteTokens)
  )
    issues.push("invalid_cache_split");
  if (
    Object.keys(split).some(
      (key) =>
        !["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"].includes(
          key,
        ),
    )
  )
    issues.push("unsupported_cache_ttl");
  if (!validSplit) issues.push("invalid_cache_split");
  return {
    inputTokens: read("input_tokens"),
    outputTokens: read("output_tokens"),
    cacheReadTokens: read("cache_read_input_tokens", true),
    cacheWriteTokens,
    cacheWrite1hTokens: validSplit ? oneHour : 0,
  };
}

function decimal(value: string, scale: number): bigint {
  // Leading zeroes are valid decimal notation. Bound input before BigInt work.
  if (value.length > 128 || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error("Billing charges must be nonnegative decimal amounts");
  }
  const [whole, fraction = ""] = value.split(".");
  const digits = fraction.padEnd(scale + 1, "0");
  return (
    BigInt(whole) * 10n ** BigInt(scale) +
    BigInt(digits.slice(0, scale)) +
    (Number(digits[scale]) >= 5 ? 1n : 0n)
  );
}

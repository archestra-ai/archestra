import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { type SupportedProvider, TimeInMs } from "@archestra/shared";
import { normalizeModelPrice } from "@archestra/shared/model-price";
import { LRUCacheManager } from "@/cache-manager";
import { withDbTransaction } from "@/database";
import { isModelHistoryIndexReady } from "@/database/index-maintenance";
import logger from "@/logging";
import {
  InteractionCostBackfillModel,
  LlmProviderApiKeyModelLinkModel,
  ModelCostBackfillModel,
  ModelModel,
} from "@/models";
import type {
  BackfillScope,
  CostBackfillRow,
  CostHistoryDay,
  CostWindowTotals,
  RecomputedCost,
  SettledReceipt,
  TieredTokenSums,
  TokenSums,
} from "@/models/interaction-cost-backfill";
import { isLongContextPrompt } from "@/models/model";
import {
  priceCacheUsage,
  priceTokenUsage,
} from "@/routes/proxy/utils/cost-optimization";
import { quotedPrices } from "@/services/billable-usage";
import { taskQueueService } from "@/task-queue";
import { ApiError, type Model } from "@/types";
import type {
  CostBackfillAvailability,
  CostBackfillPreview,
  CostBackfillPrices,
  ModelCostBackfill,
  ModelCostBackfillPricing,
} from "@/types/model-cost-backfill";
import {
  componentCacheCosts,
  estimateMissingPrices,
  formatMoney,
  hasEstimatedPrice,
  moneyUnits,
  PRICE_ISSUES,
  type PricedBillingUsage,
  type PricedComponent,
  priceTokens,
  promptTokens,
  sumMoney,
} from "@/utils/billable-usage";

// Above the class: the exported singleton reads it while initializing.
/** Long enough to absorb a burst of preview calls while prices are typed. */
const PREVIEW_CACHE_TTL_MS = 30 * TimeInMs.Second;

class ModelCostBackfillService {
  private historyCache = new LRUCacheManager<CostHistoryDay[]>({
    maxSize: 200,
    defaultTtl: PREVIEW_CACHE_TTL_MS,
  });
  private windowCache = new LRUCacheManager<CostWindowTotals>({
    maxSize: 500,
    defaultTtl: PREVIEW_CACHE_TTL_MS,
  });

  /**
   * Recorded cost per day next to what it would be at `prices` (the model's
   * saved prices when omitted), and the totals a backfill from `since` would
   * touch. Token sums are cached briefly and priced per call, so editing a
   * price in the form only costs arithmetic.
   */
  async getPreview(params: {
    model: Model;
    prices?: CostBackfillPrices;
    timeZone: string;
    since: Date | null;
  }): Promise<CostBackfillPreview> {
    const { model } = params;
    const { pricing, instancePriced } = await this.resolvePricing(
      model,
      params.prices,
    );
    const blocked = await this.getBlocker(model, pricing, instancePriced);
    if (blocked) {
      return { availability: blocked, instancePriced, days: [], window: null };
    }

    const scope = toScope(model);
    const threshold = pricing.longContext?.threshold ?? null;
    const [history, window] = await Promise.all([
      this.getCachedHistory(scope, model.id, params.timeZone, threshold),
      params.since
        ? this.getCachedWindow(scope, model.id, params.since, threshold)
        : Promise.resolve(null),
    ]);
    // Gate on what the selected range would recompute, as start() does.
    const tokens = window
      ? window.tokens
      : sumTieredTokens(history.map((day) => day.tokens));
    if (missesCachePrice({ pricing, instancePriced, tokens })) {
      return {
        availability: "needs_custom_price",
        instancePriced,
        days: [],
        window: null,
      };
    }
    const availability = "available";
    return {
      availability,
      instancePriced,
      days: history.map((day) => ({
        day: day.day,
        requests: day.requests,
        recordedCost: day.recordedCost,
        recomputedCost: priceSums({
          pricing,
          provider: model.provider,
          tokens: day.tokens,
        }),
      })),
      window: window && {
        requests: window.requests,
        subscriptionRequests: window.subscriptionRequests,
        users: window.users,
        recordedCost: window.recordedCost,
        recomputedCost: priceSums({
          pricing,
          provider: model.provider,
          tokens: window.tokens,
        }),
      },
    };
  }

  /**
   * Start recomputing the model's requests from `since` (all of them when
   * null) up to now, at the model's saved prices. Runs in the background; one
   * at a time per model.
   */
  async start(params: {
    model: Model;
    since: Date | null;
    /**
     * The custom prices the caller saved and expects the recompute to use.
     * When another edit changed them in between, nothing starts.
     */
    expectedPrices?: CostBackfillPrices;
    organizationId: string;
    userId: string;
  }): Promise<ModelCostBackfill> {
    const { model } = params;
    if (
      params.expectedPrices &&
      !hasCustomPrices(model, params.expectedPrices)
    ) {
      throw new ApiError(409, PRICES_CHANGED_MESSAGE);
    }
    const { pricing, instancePriced } = await this.resolvePricing(model);
    const blocked = await this.getBlocker(model, pricing, instancePriced);
    if (blocked) {
      throw new ApiError(
        blocked === "index_pending" ? 409 : 400,
        UNAVAILABLE_MESSAGES[blocked],
      );
    }

    const cutoff = new Date();
    const since = params.since ?? new Date(0);
    if (since >= cutoff) {
      throw new ApiError(400, "The start of the range must be in the past");
    }
    const totals = await InteractionCostBackfillModel.getWindowTotals({
      scope: toScope(model),
      since,
      until: cutoff,
      longContextThreshold: pricing.longContext?.threshold ?? null,
    });
    if (missesCachePrice({ pricing, instancePriced, tokens: totals.tokens })) {
      throw new ApiError(400, UNAVAILABLE_MESSAGES.needs_custom_price);
    }
    // Checked up front: one overflowing row would fail its batch every retry
    // and leave the history half rewritten.
    if (
      mayOverflow({
        pricing,
        provider: model.provider,
        bound: totals.largestRequestBound,
      })
    ) {
      throw new ApiError(
        400,
        "At these prices one past request would cost more than $999.99, more than a request's cost can hold. Check the prices.",
      );
    }
    // The snapshot is taken from the prices read above. Holding the model row
    // while the backfill is created means no edit or catalog sync lands in
    // between; one that landed during the totals query refuses the start.
    const backfill = await withDbTransaction(async (tx) => {
      const current = await ModelModel.findByIdForUpdate(model.id, tx);
      if (
        !current ||
        !isDeepStrictEqual(
          pricingFor({ model: current, instancePriced }),
          pricing,
        )
      ) {
        throw new ApiError(409, PRICES_CHANGED_MESSAGE);
      }
      return ModelCostBackfillModel.create(
        {
          organizationId: params.organizationId,
          modelId: model.id,
          since,
          cutoff,
          pricing: { provider: model.provider, ...pricing },
          rowsEstimated: totals.requests,
          createdByUserId: params.userId,
        },
        tx,
      );
    });
    if (!backfill) {
      throw new ApiError(
        409,
        "Past costs for this model are already being recomputed",
      );
    }

    // Starts it now rather than at the next periodic check. If this enqueue
    // fails the backfill still exists and that check picks it up.
    try {
      await taskQueueService.enqueue({
        taskType: "model_cost_backfill",
        payload: {},
        maxAttempts: 1,
      });
    } catch (error) {
      logger.warn(
        { err: error, backfillId: backfill.id },
        "[ModelCostBackfill] Could not enqueue an immediate run; the periodic check will start it",
      );
    }
    return backfill;
  }

  async getLatest(modelId: string): Promise<ModelCostBackfill | null> {
    return ModelCostBackfillModel.findLatestForModel(modelId);
  }

  /**
   * Claim one active backfill and work it for up to the time budget, one
   * batch per transaction. A backfill left unfinished is released and picked
   * up again from its cursor by the next run.
   */
  async runNext(params?: { timeBudgetMs?: number }): Promise<void> {
    const backfill = await ModelCostBackfillModel.claimNext({
      owner: WORKER_ID,
      leaseTtlSeconds: LEASE_TTL_SECONDS,
    });
    if (!backfill) return;

    const lease = { id: backfill.id, epoch: backfill.leaseEpoch };
    const deadline = Date.now() + (params?.timeBudgetMs ?? RUN_TIME_BUDGET_MS);
    try {
      await this.work(backfill, deadline);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { err: error, backfillId: backfill.id },
        "[ModelCostBackfill] Batch failed; will retry from the last committed batch",
      );
      await ModelCostBackfillModel.recordFailure({
        ...lease,
        error: message,
        maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
      });
    }
  }

  // ===

  private async work(
    backfill: ModelCostBackfill,
    deadline: number,
  ): Promise<void> {
    const lease = { id: backfill.id, epoch: backfill.leaseEpoch };
    const model = await ModelModel.findById(backfill.modelId);
    if (!model) return; // deleted; its backfill rows cascade away with it
    const scope = toScope(model);
    const { pricing } = backfill;

    let phase = backfill.phase;
    let cursor =
      backfill.cursorCreatedAt && backfill.cursorId
        ? { createdAt: backfill.cursorCreatedAt, id: backfill.cursorId }
        : null;

    // At least one batch per claim, so every run makes progress.
    do {
      const rows = await InteractionCostBackfillModel.findBatch({
        scope,
        from: phase === "main" ? backfill.since : sweepStart(backfill),
        until: backfill.cutoff,
        after: cursor,
        limit: BATCH_SIZE,
      });

      if (rows.length === 0) {
        if (phase === "main") {
          if (!(await ModelCostBackfillModel.startSweep(lease))) return;
          phase = "sweep";
          cursor = null;
          continue;
        }
        if (await ModelCostBackfillModel.complete(lease)) {
          this.historyCache.deleteByPrefix(`${backfill.modelId}:`);
          this.windowCache.deleteByPrefix(`${backfill.modelId}:`);
          logger.info(
            { backfillId: backfill.id, modelId: backfill.modelId },
            "[ModelCostBackfill] Completed",
          );
        }
        return;
      }

      const last = rows[rows.length - 1];
      const batchStarted = Date.now();
      const owned = await withDbTransaction(async (tx) => {
        if (!(await ModelCostBackfillModel.lockOwned(lease, tx))) return false;
        const updated = await InteractionCostBackfillModel.applyBatch(
          rows.map((row) => recompute(row, pricing, scope)),
          tx,
        );
        return ModelCostBackfillModel.advance(
          {
            ...lease,
            cursor: { createdAt: last.createdAt, id: last.id },
            // The sweep revisits rows the main pass already counted.
            rowsScanned: phase === "main" ? rows.length : 0,
            rowsUpdated: updated,
            leaseTtlSeconds: LEASE_TTL_SECONDS,
          },
          tx,
        );
      });
      if (!owned) return; // another worker reclaimed it
      cursor = { createdAt: last.createdAt, id: last.id };

      // Each rewritten row is a new version in every index of a wide, hot
      // table. Resting in proportion to how long the batch took keeps the
      // write rate (and WAL) a fraction of what the database can absorb, and
      // backs off on its own when the proxy's inserts slow the batches down.
      const pause = (Date.now() - batchStarted) * THROTTLE_RATIO;
      if (Date.now() + pause >= deadline) break;
      await sleep(pause);
    } while (Date.now() < deadline);

    await ModelCostBackfillModel.release(lease);
  }

  /** The prices a recompute uses; see {@link pricingFor}. */
  private async resolvePricing(
    model: Model,
    prices?: CostBackfillPrices,
  ): Promise<{ pricing: BackfillPricing; instancePriced: boolean }> {
    const instancePriced =
      model.provider !== "openrouter" &&
      (await LlmProviderApiKeyModelLinkModel.hasProviderPricing(model.id));
    return {
      instancePriced,
      pricing: pricingFor({ model, prices, instancePriced }),
    };
  }

  /** Why the model's past costs can't be recomputed, before reading any rows. */
  private async getBlocker(
    model: Model,
    pricing: BackfillPricing,
    instancePriced: boolean,
  ): Promise<Exclude<CostBackfillAvailability, "available"> | null> {
    if (model.provider === "openrouter") return "provider_reported_cost";
    if (instancePriced && pricing.source !== "custom") {
      return "needs_custom_price";
    }
    if (!(await isModelHistoryIndexReady())) return "index_pending";
    return null;
  }

  private async getCachedHistory(
    scope: BackfillScope,
    modelId: string,
    timeZone: string,
    longContextThreshold: number | null,
  ): Promise<CostHistoryDay[]> {
    const key = `${modelId}:${timeZone}:${longContextThreshold}`;
    const cached = this.historyCache.get(key);
    if (cached) return cached;
    const history = await InteractionCostBackfillModel.getDailyHistory({
      scope,
      timeZone,
      longContextThreshold,
    });
    this.historyCache.set(key, history);
    return history;
  }

  private async getCachedWindow(
    scope: BackfillScope,
    modelId: string,
    since: Date,
    longContextThreshold: number | null,
  ): Promise<CostWindowTotals> {
    const key = `${modelId}:${since.toISOString()}:${longContextThreshold}`;
    const cached = this.windowCache.get(key);
    if (cached) return cached;
    const totals = await InteractionCostBackfillModel.getWindowTotals({
      scope,
      since,
      until: new Date(),
      longContextThreshold,
    });
    this.windowCache.set(key, totals);
    return totals;
  }
}

export const modelCostBackfillService = new ModelCostBackfillService();

// ===

type ResolvedPricing = ReturnType<typeof ModelModel.getEffectivePricing>;
/** The base prices plus the model's long-context tier, as a backfill freezes them. */
type BackfillPricing = Omit<ModelCostBackfillPricing, "provider">;

const WORKER_ID = `${hostname()}#${process.pid}`;
/** Rows per transaction: short enough to keep row locks brief. */
const BATCH_SIZE = 1_000;
/** Matches the other interaction backfills on the system lane. */
const RUN_TIME_BUDGET_MS = 45_000;
/** Renewed every batch; a dead worker's backfill is reclaimable after this. */
const LEASE_TTL_SECONDS = 120;
const MAX_CONSECUTIVE_FAILURES = 10;
/** Rest this many times a batch's duration after it: writes ≤ 1/10 of the time. */
const THROTTLE_RATIO = 9;
/**
 * Requests in flight when a backfill starts can commit after the main pass has
 * passed their timestamp; the sweep revisits this much time before the cutoff.
 */
const SWEEP_WINDOW_MS = 15 * TimeInMs.Minute;

/** `interactions.cost`, `cache_cost` and `cache_savings` are `numeric(13,10)`. */
const MAX_STORED_COST = 999.9999999999;

const PRICES_CHANGED_MESSAGE =
  "This model's prices changed since you saved them. Review the new prices and try again.";

const UNAVAILABLE_MESSAGES: Record<
  Exclude<CostBackfillAvailability, "available">,
  string
> = {
  index_pending:
    "The index for recomputing costs is still being built. Try again in a few minutes.",
  provider_reported_cost:
    "This provider reports what requests actually cost, so recorded costs are kept.",
  needs_custom_price:
    "Provider keys price this model individually. Set custom input and output prices first, and cache prices if its requests used the cache.",
};

/**
 * The model's effective prices, or as they'd be with `prices` saved. For a
 * model that provider keys price individually (LiteLLM), only the admin's
 * custom cache prices apply: past rows don't record their key, and the proxy
 * never derives a cache price such a key did not publish, so neither does the
 * recompute.
 */
function pricingFor(params: {
  model: Model;
  prices?: CostBackfillPrices;
  instancePriced: boolean;
}): BackfillPricing {
  const { model, prices } = params;
  const priced: Model = prices
    ? {
        ...model,
        customPricePerMillionInput: toStoredPrice(prices.input),
        customPricePerMillionOutput: toStoredPrice(prices.output),
        customPricePerMillionCacheRead: toStoredPrice(prices.cacheRead),
        customPricePerMillionCacheWrite: toStoredPrice(prices.cacheWrite),
      }
    : model;
  const pricing = ModelModel.getEffectivePricing(
    priced,
    model.modelId,
    model.provider,
  );
  // Long-context prices are the model's own, the same for every key, so they
  // apply as the proxy applies them; resolved just past the threshold.
  const threshold = model.longContextThreshold;
  const longContext =
    threshold === null
      ? null
      : {
          threshold,
          prices: ModelModel.getEffectivePricing(
            priced,
            model.modelId,
            model.provider,
            threshold + 1,
          ),
        };
  if (!params.instancePriced) return { ...pricing, longContext };

  const cacheRead =
    priced.customPricePerMillionCacheRead != null
      ? pricing.pricePerMillionCacheRead
      : null;
  const cacheWrite =
    priced.customPricePerMillionCacheWrite != null
      ? pricing.pricePerMillionCacheWrite
      : null;
  return {
    ...pricing,
    pricePerMillionCacheRead: cacheRead,
    pricePerMillionCacheWrite: cacheWrite,
    cacheSource:
      cacheRead === null && cacheWrite === null ? null : pricing.cacheSource,
    longContext,
  };
}

function toScope(model: Model): BackfillScope {
  return { modelId: model.modelId, provider: model.provider };
}

/** Whether the model's stored custom prices are `prices`, as stored. */
function hasCustomPrices(model: Model, prices: CostBackfillPrices): boolean {
  const stored = customPricesOf(model);
  return (Object.keys(prices) as Array<keyof CostBackfillPrices>).every(
    (key) => {
      const expected = toStoredPrice(prices[key]);
      const actual = stored[key];
      return expected === null || actual === null
        ? expected === actual
        : expected === normalizeModelPrice(actual);
    },
  );
}

function customPricesOf(model: Model): CostBackfillPrices {
  return {
    input: model.customPricePerMillionInput,
    output: model.customPricePerMillionOutput,
    cacheRead: model.customPricePerMillionCacheRead,
    cacheWrite: model.customPricePerMillionCacheWrite,
  };
}

/** Normalize unsaved prices with the same decimal contract as model updates. */
function toStoredPrice(price: string | null): string | null {
  return price === null ? null : normalizeModelPrice(price);
}

/**
 * A per-key priced model with cached requests but no custom price for that
 * kind of cache token: the proxy would record no cost for such a request, so
 * the recompute can't invent one.
 */
function missesCachePrice(params: {
  pricing: BackfillPricing;
  instancePriced: boolean;
  tokens: TieredTokenSums;
}): boolean {
  const { pricing, instancePriced, tokens } = params;
  const misses = (prices: ResolvedPricing, sums: TokenSums) =>
    (sums.cacheReadTokens > 0 && prices.pricePerMillionCacheRead === null) ||
    (sums.cacheWriteTokens > 0 && prices.pricePerMillionCacheWrite === null);
  return (
    instancePriced &&
    tierPrices(pricing).some(([tier, prices]) => misses(prices, tokens[tier]))
  );
}

function sumTieredTokens(all: TieredTokenSums[]): TieredTokenSums {
  return {
    base: sumTokens(all.map((tokens) => tokens.base)),
    long: sumTokens(all.map((tokens) => tokens.long)),
  };
}

function sumTokens(all: TokenSums[]): TokenSums {
  return all.reduce(
    (total, tokens) => ({
      inputTokens: total.inputTokens + tokens.inputTokens,
      outputTokens: total.outputTokens + tokens.outputTokens,
      cacheReadTokens: total.cacheReadTokens + tokens.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + tokens.cacheWriteTokens,
      cacheWrite1hTokens: total.cacheWrite1hTokens + tokens.cacheWrite1hTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
    },
  );
}

function sweepStart(backfill: ModelCostBackfill): Date {
  const start = backfill.cutoff.getTime() - SWEEP_WINDOW_MS;
  return new Date(Math.max(backfill.since.getTime(), start));
}

/** Each tier's prices; a model without a long-context tier has only base. */
function tierPrices(
  pricing: BackfillPricing,
): Array<[keyof TieredTokenSums, ResolvedPricing]> {
  return pricing.longContext
    ? [
        ["base", pricing],
        ["long", pricing.longContext.prices],
      ]
    : [["base", pricing]];
}

/**
 * The prices the proxy applies to a request of this prompt size: the
 * long-context tier above its threshold, the base prices otherwise.
 */
function pricesFor(pricing: BackfillPricing, row: CostBackfillRow) {
  return pricesForPrompt(
    pricing,
    promptTokens({
      inputTokens: row.inputTokens ?? 0,
      cacheReadTokens: row.cacheReadTokens ?? 0,
      cacheWriteTokens: row.cacheWriteTokens ?? 0,
    }),
  );
}

function pricesForPrompt(pricing: BackfillPricing, prompt: number) {
  const { longContext } = pricing;
  return longContext && isLongContextPrompt(longContext.threshold, prompt)
    ? longContext.prices
    : pricing;
}

/**
 * Whether a request within its tier's `bound` could store an amount (cost,
 * cache cost or cache savings, which can be negative) past
 * {@link MAX_STORED_COST}. Each amount is linear in each token kind within a
 * tier, so pricing every kind's largest count on its own at that tier's prices
 * and adding the magnitudes bounds what any one request reaches.
 */
function mayOverflow(params: {
  pricing: BackfillPricing;
  provider: SupportedProvider;
  bound: TieredTokenSums;
}): boolean {
  return tierPrices(params.pricing).some(([tier, prices]) =>
    tierMayOverflow({
      prices,
      provider: params.provider,
      bound: params.bound[tier],
    }),
  );
}

function tierMayOverflow(params: {
  prices: ResolvedPricing;
  provider: SupportedProvider;
  bound: TokenSums;
}): boolean {
  const { bound } = params;
  const none = {
    id: "",
    createdAt: "",
    receipt: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
  };
  const kinds: CostBackfillRow[][] = [
    [{ ...none, inputTokens: bound.inputTokens }],
    [{ ...none, outputTokens: bound.outputTokens }],
    [{ ...none, cacheReadTokens: bound.cacheReadTokens }],
    // Writes at either cache lifetime, whichever amounts to more.
    [
      { ...none, cacheWriteTokens: bound.cacheWriteTokens },
      {
        ...none,
        cacheWriteTokens: bound.cacheWriteTokens,
        cacheWrite1hTokens: bound.cacheWriteTokens,
      },
    ],
  ];
  const magnitudes = (row: CostBackfillRow) => {
    const amounts = recomputeAt(row, params.prices, params.provider);
    return [amounts.cost, amounts.cacheCost, amounts.cacheSavings].map(
      (amount) => Math.abs(Number(amount ?? 0)),
    );
  };
  const totals = [0, 0, 0];
  for (const rows of kinds) {
    const each = rows.map(magnitudes);
    totals.forEach((_, i) => {
      totals[i] += Math.max(...each.map((amounts) => amounts[i]));
    });
  }
  return totals.some((total) => total > MAX_STORED_COST);
}

/** A request's cost at the backfill's prices, as the write path stores it. */
function recompute(
  row: CostBackfillRow,
  pricing: ModelCostBackfillPricing,
  scope: BackfillScope,
): RecomputedCost {
  if (row.receipt)
    return recomputeReceipt({
      id: row.id,
      receipt: row.receipt,
      pricing,
      scope,
    });
  return recomputeAt(row, pricesFor(pricing, row), pricing.provider);
}

/**
 * A settled request re-priced from its receipt, as settlement prices it: each
 * of this model's components at its own prompt size, missing rates estimated.
 * Components of other models, and charges a provider reported, keep their
 * cost. The difference moves into the budgets the request was charged to.
 */
function recomputeReceipt(params: {
  id: string;
  receipt: SettledReceipt;
  pricing: ModelCostBackfillPricing;
  scope: BackfillScope;
}): RecomputedCost {
  const { receipt, pricing, scope } = params;
  const before = receipt.usage;
  // A provider-reported charge is OpenRouter's, whose models are never
  // recomputed, so a "provider" source here is a per-key price list.
  const ours = (component: PricedComponent) =>
    component.model === scope.modelId && component.provider === scope.provider;
  const components = before.components.map((component) => {
    if (!ours(component)) return component;
    const resolved = pricesForPrompt(pricing, promptTokens(component));
    const quoted = quotedPrices({
      model: component.model,
      provider: component.provider,
      pricing: resolved,
      instancePriced: false,
    });
    const estimate = estimateMissingPrices({
      usage: component,
      prices: quoted.prices,
      provider: component.provider,
    });
    try {
      return {
        ...component,
        prices: quoted.prices,
        cost: priceTokens(component, estimate.prices),
      };
    } catch {
      // Invalid token counts keep the charge settlement made; only the known
      // rates move, so a price set since then clears its estimate.
      return { ...component, prices: quoted.prices };
    }
  });
  // Price findings are per receipt, so they are redone from every
  // component's known rates, including other models' components.
  const flags = components.map(estimatedRates);
  const issues = [
    ...before.issues.filter((issue) => !PRICE_ISSUES.has(issue)),
    ...(flags.some((flag) => flag.model) ? ["estimated_model_price"] : []),
    ...(flags.some((flag) => flag.cache) ? ["estimated_cache_price"] : []),
  ];
  const status = issues.length
    ? ("incomplete" as const)
    : ("complete" as const);
  const usage: PricedBillingUsage = {
    ...before,
    status,
    issues,
    components,
    cost: sumMoney(components.map((component) => component.cost)),
  };

  const costOf = (list: PricedComponent[]) =>
    moneyUnits(sumMoney(list.filter(ours).map((component) => component.cost)));
  const costDelta = costOf(components) - costOf(before.components);
  const estimatedDelta =
    Number(hasEstimatedPrice(usage)) - Number(hasEstimatedPrice(before));
  // Settlement flagged the receipt on every model it charged, so a change in
  // the flag moves on each of them; the cost moves only on this model.
  const entities = receipt.entities;
  const budgetChanges =
    entities?.length && receipt.billingMode !== "subscription"
      ? [...new Set(before.components.map((component) => component.model))]
          .map((model) => ({
            model,
            delta: model === scope.modelId ? costDelta : 0n,
          }))
          .filter(({ delta }) => delta !== 0n || estimatedDelta !== 0)
          .map(({ model, delta }) => ({
            chargedAt: receipt.createdAt,
            entities,
            model,
            costDelta: formatMoney(delta),
            estimatedDelta,
          }))
      : [];

  const cached = components.some(
    (component) =>
      component.cacheReadTokens > 0 || component.cacheWriteTokens > 0,
  );
  const cache = components.map(componentCacheCosts);
  const total = (key: "cacheCost" | "cacheSavings") =>
    cache.reduce((sum, item) => sum + item[key], 0).toFixed(10);
  return {
    id: params.id,
    cost: usage.cost,
    cacheCost: cached ? total("cacheCost") : null,
    cacheSavings: cached ? total("cacheSavings") : null,
    receipt: { usage, budgetChanges },
  };
}

/**
 * Which kinds of rate a priced component needed but its receipt lacks, read
 * from the rates the receipt kept, as settlement flags them. A charge the
 * provider reported is exact.
 */
function estimatedRates(component: PricedComponent): {
  model: boolean;
  cache: boolean;
} {
  if (
    component.provider === "openrouter" &&
    component.prices.source === "provider"
  )
    return { model: false, cache: false };
  const { model, cache } = estimateMissingPrices({
    usage: component,
    prices: component.prices,
    provider: component.provider,
  });
  const placeholder =
    component.prices.source === "default" &&
    (component.prices.input !== "0.00" || component.prices.output !== "0.00");
  return { model: model || placeholder, cache };
}

function recomputeAt(
  row: CostBackfillRow,
  pricing: ResolvedPricing,
  provider: SupportedProvider,
): RecomputedCost {
  const usage = {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    readTokens: row.cacheReadTokens,
    writeTokens: row.cacheWriteTokens,
    write1hTokens: row.cacheWrite1hTokens,
  };
  const cost = priceTokenUsage({ pricing, provider, usage }) ?? 0;
  const cache = priceCacheUsage({ pricing, provider, usage });
  return {
    id: row.id,
    cost: cost.toFixed(10),
    cacheCost: cache?.cacheCost.toFixed(10) ?? null,
    cacheSavings: cache?.cacheSavings.toFixed(10) ?? null,
  };
}

/** Pricing is linear in each token count within a tier, so tier sums price exactly. */
function priceSums(params: {
  pricing: BackfillPricing;
  provider: SupportedProvider;
  tokens: TieredTokenSums;
}): number {
  const { provider, tokens } = params;
  return tierPrices(params.pricing).reduce(
    (total, [tier, pricing]) =>
      total +
      (priceTokenUsage({
        pricing,
        provider,
        usage: {
          inputTokens: tokens[tier].inputTokens,
          outputTokens: tokens[tier].outputTokens,
          readTokens: tokens[tier].cacheReadTokens,
          writeTokens: tokens[tier].cacheWriteTokens,
          write1hTokens: tokens[tier].cacheWrite1hTokens,
        },
      }) ?? 0),
    0,
  );
}

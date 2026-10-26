import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { type SupportedProvider, TimeInMs } from "@archestra/shared";
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
  TokenSums,
} from "@/models/interaction-cost-backfill";
import {
  priceCacheUsage,
  priceTokenUsage,
} from "@/routes/proxy/utils/cost-optimization";
import { taskQueueService } from "@/task-queue";
import { ApiError, type Model } from "@/types";
import type {
  CostBackfillAvailability,
  CostBackfillPreview,
  CostBackfillPrices,
  ModelCostBackfill,
  ModelCostBackfillPricing,
} from "@/types/model-cost-backfill";

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
    const [history, window] = await Promise.all([
      this.getCachedHistory(scope, model.id, params.timeZone),
      params.since
        ? this.getCachedWindow(scope, model.id, params.since)
        : Promise.resolve(null),
    ]);
    // Gate on what the selected range would recompute, as start() does.
    const tokens = window
      ? window.tokens
      : sumTokens(history.map((day) => day.tokens));
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
        settledRequests: window.settledRequests,
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
    });
    if (missesCachePrice({ pricing, instancePriced, tokens: totals.tokens })) {
      throw new ApiError(400, UNAVAILABLE_MESSAGES.needs_custom_price);
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
          rows.map((row) => recompute(row, pricing)),
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
  ): Promise<{ pricing: ResolvedPricing; instancePriced: boolean }> {
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
    pricing: ResolvedPricing,
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
  ): Promise<CostHistoryDay[]> {
    const key = `${modelId}:${timeZone}`;
    const cached = this.historyCache.get(key);
    if (cached) return cached;
    const history = await InteractionCostBackfillModel.getDailyHistory({
      scope,
      timeZone,
    });
    this.historyCache.set(key, history);
    return history;
  }

  private async getCachedWindow(
    scope: BackfillScope,
    modelId: string,
    since: Date,
  ): Promise<CostWindowTotals> {
    const key = `${modelId}:${since.toISOString()}`;
    const cached = this.windowCache.get(key);
    if (cached) return cached;
    const totals = await InteractionCostBackfillModel.getWindowTotals({
      scope,
      since,
      until: new Date(),
    });
    this.windowCache.set(key, totals);
    return totals;
  }
}

export const modelCostBackfillService = new ModelCostBackfillService();

// ===

type ResolvedPricing = ReturnType<typeof ModelModel.getEffectivePricing>;

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
}): ResolvedPricing {
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
  if (!params.instancePriced) return pricing;

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
        : Number(expected) === Number(actual);
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

/**
 * The price as `numeric(10,2)` will store it, so the preview prices what Save
 * stores. Decimal half-up on the digits themselves: binary `toFixed` rounds
 * "1.005" down where Postgres rounds it up.
 */
function toStoredPrice(price: string | null): string | null {
  if (price === null) return null;
  const [whole, fraction = ""] = price.split(".");
  const roundUp = fraction.length > 2 && fraction[2] >= "5" ? 1n : 0n;
  const cents = BigInt(whole + fraction.padEnd(2, "0").slice(0, 2)) + roundUp;
  const digits = cents.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * A per-key priced model with cached requests but no custom price for that
 * kind of cache token: the proxy would record no cost for such a request, so
 * the recompute can't invent one.
 */
function missesCachePrice(params: {
  pricing: ResolvedPricing;
  instancePriced: boolean;
  tokens: TokenSums;
}): boolean {
  const { pricing, instancePriced, tokens } = params;
  return (
    instancePriced &&
    ((tokens.cacheReadTokens > 0 &&
      pricing.pricePerMillionCacheRead === null) ||
      (tokens.cacheWriteTokens > 0 &&
        pricing.pricePerMillionCacheWrite === null))
  );
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

/** A request's cost at the backfill's prices, as the write path stores it. */
function recompute(
  row: CostBackfillRow,
  pricing: ModelCostBackfillPricing,
): RecomputedCost {
  const usage = {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    readTokens: row.cacheReadTokens,
    writeTokens: row.cacheWriteTokens,
    write1hTokens: row.cacheWrite1hTokens,
  };
  const cost =
    priceTokenUsage({ pricing, provider: pricing.provider, usage }) ?? 0;
  const cache = priceCacheUsage({ pricing, provider: pricing.provider, usage });
  return {
    id: row.id,
    cost: cost.toFixed(10),
    cacheCost: cache?.cacheCost.toFixed(10) ?? null,
    cacheSavings: cache?.cacheSavings.toFixed(10) ?? null,
  };
}

/** Pricing is linear in each token count, so summed tokens price exactly. */
function priceSums(params: {
  pricing: ResolvedPricing;
  provider: SupportedProvider;
  tokens: TokenSums;
}): number {
  const { pricing, provider, tokens } = params;
  return (
    priceTokenUsage({
      pricing,
      provider,
      usage: {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        readTokens: tokens.cacheReadTokens,
        writeTokens: tokens.cacheWriteTokens,
        write1hTokens: tokens.cacheWrite1hTokens,
      },
    }) ?? 0
  );
}

import { hostname } from "node:os";
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
    const pricing = resolvePricing(model, params.prices);
    const { availability, instancePriced } = await this.getAvailability(
      model,
      pricing,
    );
    if (availability !== "available") {
      return { availability, instancePriced, days: [], window: null };
    }

    const scope = toScope(model);
    const [history, window] = await Promise.all([
      this.getCachedHistory(scope, model.id, params.timeZone),
      params.since
        ? this.getCachedWindow(scope, model.id, params.since)
        : Promise.resolve(null),
    ]);
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
    organizationId: string;
    userId: string;
  }): Promise<ModelCostBackfill> {
    const { model } = params;
    const pricing = resolvePricing(model);
    const { availability } = await this.getAvailability(model, pricing);
    if (availability !== "available") {
      throw new ApiError(
        availability === "index_pending" ? 409 : 400,
        UNAVAILABLE_MESSAGES[availability],
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
    const backfill = await ModelCostBackfillModel.create({
      organizationId: params.organizationId,
      modelId: model.id,
      since,
      cutoff,
      pricing: { provider: model.provider, ...pricing },
      rowsEstimated: totals.requests,
      createdByUserId: params.userId,
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
    } while (Date.now() < deadline);

    await ModelCostBackfillModel.release(lease);
  }

  private async getAvailability(
    model: Model,
    pricing: ResolvedPricing,
  ): Promise<{
    availability: CostBackfillAvailability;
    instancePriced: boolean;
  }> {
    if (model.provider === "openrouter") {
      return { availability: "provider_reported_cost", instancePriced: false };
    }
    const instancePriced =
      await LlmProviderApiKeyModelLinkModel.hasProviderPricing(model.id);
    if (instancePriced && pricing.source !== "custom") {
      return { availability: "needs_custom_price", instancePriced };
    }
    if (!(await isModelHistoryIndexReady())) {
      return { availability: "index_pending", instancePriced };
    }
    return { availability: "available", instancePriced };
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
/**
 * Requests in flight when a backfill starts can commit after the main pass has
 * passed their timestamp; the sweep revisits this much time before the cutoff.
 */
const SWEEP_WINDOW_MS = 15 * TimeInMs.Minute;

const UNAVAILABLE_MESSAGES: Record<
  Exclude<CostBackfillAvailability, "available">,
  string
> = {
  index_pending:
    "The index for recomputing costs is still being built. Try again in a few minutes.",
  provider_reported_cost:
    "This provider reports what requests actually cost, so recorded costs are kept.",
  needs_custom_price:
    "Provider keys price this model individually. Set a custom input and output price first.",
};

function toScope(model: Model): BackfillScope {
  return { modelId: model.modelId, provider: model.provider };
}

function resolvePricing(
  model: Model,
  prices?: CostBackfillPrices,
): ResolvedPricing {
  const priced = prices
    ? {
        ...model,
        customPricePerMillionInput: toStoredPrice(prices.input),
        customPricePerMillionOutput: toStoredPrice(prices.output),
        customPricePerMillionCacheRead: toStoredPrice(prices.cacheRead),
        customPricePerMillionCacheWrite: toStoredPrice(prices.cacheWrite),
      }
    : model;
  return ModelModel.getEffectivePricing(priced, model.modelId, model.provider);
}

/** Custom prices are stored with two decimals; preview what Save will store. */
function toStoredPrice(price: string | null): string | null {
  return price === null ? null : Number(price).toFixed(2);
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

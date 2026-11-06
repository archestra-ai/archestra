import { setTimeout as sleep } from "node:timers/promises";
import { LlmUsageRollupModel } from "@/models";

/**
 * Keeps `llm_usage_hourly` current. Driven by the `llm_usage_rollup` periodic
 * task; each run works for a bounded time and the next continues.
 *
 * Marked hours go first (a change since they were rolled, or a settle pass
 * that is now due), oldest first, then the next hour not rolled yet. On a
 * deployment with history this second step is the backfill: it walks from the
 * oldest interaction hour forward, and cost statistics read raw rows for
 * whatever it has not reached, so they are correct throughout and get faster
 * as it goes. Between hours it pauses for a multiple of the time the hour
 * took, so the walk takes a bounded share of database time.
 */
class LlmUsageRollupService {
  async run(
    params: { timeBudgetMs?: number; throttleRatio?: number } = {},
  ): Promise<{ recomputed: number; rolled: number }> {
    const deadline = Date.now() + (params.timeBudgetMs ?? RUN_TIME_BUDGET_MS);
    const throttleRatio = params.throttleRatio ?? THROTTLE_RATIO;
    let recomputed = 0;
    let rolled = 0;

    while (Date.now() < deadline) {
      const started = Date.now();
      const marked = await LlmUsageRollupModel.nextMarkedHour();
      if (marked) {
        await LlmUsageRollupModel.recomputeMarkedHour(marked);
        recomputed++;
      } else {
        const hour = await LlmUsageRollupModel.nextUnrolledHour();
        if (!hour) break;
        await LlmUsageRollupModel.rollHour(hour);
        rolled++;
      }
      const pause = (Date.now() - started) * throttleRatio;
      if (pause > 0) await sleep(pause);
    }
    return { recomputed, rolled };
  }
}

export const llmUsageRollup = new LlmUsageRollupService();

// =============================================================================
// Internal helpers
// =============================================================================

const RUN_TIME_BUDGET_MS = 45_000;
/** Pause after each hour, as a multiple of the time it took. */
const THROTTLE_RATIO = 3;

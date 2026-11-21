import { setTimeout as sleep } from "node:timers/promises";
import { LlmUsageRollupModel } from "@/models";

/**
 * Keeps `llm_usage_hourly` current. Driven by the `llm_usage_rollup` periodic
 * task; each run works for a bounded time and the next continues.
 *
 * It alternates between marked hours (a change since they were rolled, or a
 * settle pass that is now due), oldest first, and the next hour not rolled
 * yet. On a
 * deployment with history this second step is the backfill: it walks from the
 * oldest interaction hour forward, and cost statistics read raw rows for
 * whatever it has not reached, so they are correct throughout and get faster
 * as it goes. Between hours it pauses for a multiple of the time the hour
 * took, so the walk takes a bounded share of database time.
 *
 * With neither to do, it refreshes an hour rolled before the rollup kept
 * `run`, newest first, until none is left; Adoption reads those hours from raw
 * rows meanwhile.
 */
class LlmUsageRollupService {
  async run(
    params: { timeBudgetMs?: number; throttleRatio?: number } = {},
  ): Promise<{ recomputed: number; rolled: number; refreshed: number }> {
    const deadline = Date.now() + (params.timeBudgetMs ?? RUN_TIME_BUDGET_MS);
    const throttleRatio = params.throttleRatio ?? THROTTLE_RATIO;
    let recomputed = 0;
    let rolled = 0;
    let refreshed = 0;

    // Alternate the two kinds of work, so a stream of changes to rolled hours
    // cannot hold back rolling, nor rolling the changes.
    let rollFirst = false;
    while (Date.now() < deadline) {
      const started = Date.now();
      const done: "rolled" | "recomputed" | "refreshed" | null =
        (rollFirst
          ? (await this.roll()) || (await this.recompute())
          : (await this.recompute()) || (await this.roll())) ||
        (await this.refresh());
      if (!done) break;
      if (done === "rolled") rolled++;
      else if (done === "recomputed") recomputed++;
      else refreshed++;
      rollFirst = done === "recomputed";
      const pause = (Date.now() - started) * throttleRatio;
      if (pause > 0) await sleep(pause);
    }
    return { recomputed, rolled, refreshed };
  }

  private async recompute(): Promise<"recomputed" | null> {
    const marked = await LlmUsageRollupModel.nextMarkedHour();
    if (!marked) return null;
    await LlmUsageRollupModel.recomputeMarkedHour(marked);
    return "recomputed";
  }

  private async refresh(): Promise<"refreshed" | null> {
    const hour = await LlmUsageRollupModel.nextHourWithoutRun();
    if (!hour) return null;
    await LlmUsageRollupModel.refreshHour(hour);
    return "refreshed";
  }

  private async roll(): Promise<"rolled" | null> {
    const hour = await LlmUsageRollupModel.nextUnrolledHour();
    if (!hour) return null;
    await LlmUsageRollupModel.rollHour(hour);
    return "rolled";
  }
}

export const llmUsageRollup = new LlmUsageRollupService();

// =============================================================================
// Internal helpers
// =============================================================================

const RUN_TIME_BUDGET_MS = 45_000;
/** Pause after each hour, as a multiple of the time it took. */
const THROTTLE_RATIO = 3;

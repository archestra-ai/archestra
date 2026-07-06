import config from "@/config";
import { ConnectorRunModel } from "@/models";

// Window over which the connector "runaway" circuit breaker counts a connector's
// runs. A time-budget chunk continuation and a reaper-driven resume are both just
// "another run", so they draw from this one budget instead of two guards (a
// per-chain payload counter and a per-window cap) that were unaware of each other.
const RESUME_WINDOW_SECONDS = 60 * 60; // 1 hour

/**
 * Whether a connector may start another run now, or has produced so many runs
 * within RESUME_WINDOW_SECONDS that it looks like a runaway (a crash loop, or
 * pathological re-chunking) and should be left alone until its next scheduled
 * cron. Counting actual runs (not a payload counter) means a chunk continuation
 * and a reaper resume share the same budget by construction.
 */
export async function withinResumeBudget(
  connectorId: string,
): Promise<boolean> {
  const recentRuns = await ConnectorRunModel.countRunsSince(
    connectorId,
    RESUME_WINDOW_SECONDS,
  );
  return recentRuns <= maxRunsPerResumeWindow();
}

/**
 * How many runs a connector may produce within RESUME_WINDOW_SECONDS before it is
 * treated as a runaway. Derived from the lease/work-budget params so it stays
 * meaningful when they are tuned, rather than being a magic number:
 *
 *  - A run cannot be reclaimed sooner than one lease TTL after it starts
 *    (`claim()` seeds the lease to `now()+TTL`), so a pure crash loop tops out at
 *    `window / leaseTtl` reclaims per window — the natural trip point (12/hour at
 *    the 300s default).
 *  - A healthy sync that chunks on the work budget adds ~`window / (0.9*syncMax)`
 *    runs per window (it stops at 90% of the budget, then continues). We keep the
 *    ceiling comfortably (×2) above that so such a sync, if it also happens to be
 *    reclaimed once, still resumes instead of tripping the breaker. This matters
 *    when `syncMax` is lowered to chunk aggressively; at the default it is ~1–2
 *    runs/hour, far below the TTL-derived term.
 *
 * Floored so a very long lease TTL (or a disabled work budget) can't drive the
 * threshold absurdly low.
 */
function maxRunsPerResumeWindow(): number {
  const leaseTtl = config.kb.connectorRunLeaseTtlSeconds;
  const syncMax = config.kb.connectorSyncMaxDurationSeconds;
  const crashLoopCeiling = Math.ceil(RESUME_WINDOW_SECONDS / leaseTtl);
  const chunkHeadroom = syncMax
    ? Math.ceil((2 * RESUME_WINDOW_SECONDS) / (0.9 * syncMax))
    : 0;
  return Math.max(6, crashLoopCeiling, chunkHeadroom);
}

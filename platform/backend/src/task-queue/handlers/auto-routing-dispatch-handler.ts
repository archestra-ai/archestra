import logger from "@/logging";
import AutoRoutingDispatchModel from "@/models/auto-routing-dispatch";
import RoutingDecisionModel from "@/models/routing-decision";

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_PURGE_RETRY_MS = 5 * 60 * 1000;
const MAX_PURGE_RETRY_MS = 60 * 60 * 1000;

/**
 * Enqueues a fit for every auto router whose plan is due — settings changed
 * since its last fit outcome, or no outcome for a day — and purges expired
 * routing history once a day per process. Failed purges back off independently of the minute dispatch tick.
 * @public — exported for isolated scheduler tests
 */
export class AutoRoutingDispatcher {
  private nextPurgeAt = 0;
  private purgeRetryMs = INITIAL_PURGE_RETRY_MS;
  private purgeInFlight = false;

  constructor(
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  async dispatch(now: Date = new Date()): Promise<void> {
    await this.purgeDaily(now);
    const due = await AutoRoutingDispatchModel.findDueRouters(
      new Date(now.getTime() - DAY_MS),
    );
    const enqueued = await AutoRoutingDispatchModel.enqueueFits(due);
    if (enqueued > 0) {
      logger.info(
        { due: due.length, enqueued },
        "[AutoRouting] Enqueued plan fits",
      );
    }
  }

  private async purgeDaily(now: Date): Promise<void> {
    if (this.purgeInFlight || now.getTime() < this.nextPurgeAt) return;
    const startedAt = this.monotonicNow();
    const completedAt = () => now.getTime() + this.monotonicNow() - startedAt;
    this.purgeInFlight = true;
    try {
      const purged = await RoutingDecisionModel.purgeExpired(now);
      this.nextPurgeAt = completedAt() + DAY_MS;
      this.purgeRetryMs = INITIAL_PURGE_RETRY_MS;
      logger.info(purged, "[AutoRouting] Purged expired routing history");
    } catch (error) {
      this.nextPurgeAt = completedAt() + this.purgeRetryMs;
      this.purgeRetryMs = Math.min(this.purgeRetryMs * 2, MAX_PURGE_RETRY_MS);
      logger.error(
        { err: error },
        "[AutoRouting] Purging expired routing history failed",
      );
    } finally {
      this.purgeInFlight = false;
    }
  }
}

export const autoRoutingDispatcher = new AutoRoutingDispatcher();

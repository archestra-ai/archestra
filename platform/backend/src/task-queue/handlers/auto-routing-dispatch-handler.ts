import { activeSourceVersion } from "@/auto-routing/signals";
import config from "@/config";
import logger from "@/logging";
import AutoRoutingDispatchModel from "@/models/auto-routing-dispatch";
import RoutingBackfillModel from "@/models/routing-backfill";
import RoutingDecisionModel from "@/models/routing-decision";
import RoutingHistoryModel from "@/models/routing-history";
import { HISTORY_MS } from "@/models/routing-usage";

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_PURGE_RETRY_MS = 5 * 60 * 1000;
const MAX_PURGE_RETRY_MS = 60 * 60 * 1000;

/**
 * Enqueues a fit for every organization whose plan is due — settings changed
 * since its last fit outcome, or no outcome for a day — resumes a backfill
 * whose worker died, and purges expired routing history once a day per
 * process. Failed purges back off independently of the minute dispatch tick.
 * @public — exported for isolated scheduler tests
 */
export class AutoRoutingDispatcher {
  private nextPurgeAt = 0;
  private purgeRetryMs = INITIAL_PURGE_RETRY_MS;
  private purgeInFlight = false;

  async dispatch(now: Date = new Date()): Promise<void> {
    await this.purgeDaily(now);
    if (!config.autoRouting.enabled) return;
    const due = await AutoRoutingDispatchModel.findDueOrganizations(
      new Date(now.getTime() - DAY_MS),
    );
    if (await RoutingBackfillModel.hasClaimable()) {
      await AutoRoutingDispatchModel.enqueueBackfillRun();
    }
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
    this.purgeInFlight = true;
    try {
      const purged = {
        ...(await RoutingDecisionModel.purgeExpired(now)),
        past: await RoutingHistoryModel.purgeExpired({
          windowStart: new Date(now.getTime() - HISTORY_MS),
          keepScorerVersionId: (await activeSourceVersion()).id,
        }),
      };
      this.nextPurgeAt = now.getTime() + DAY_MS;
      this.purgeRetryMs = INITIAL_PURGE_RETRY_MS;
      logger.info(purged, "[AutoRouting] Purged expired routing history");
    } catch (error) {
      this.nextPurgeAt = now.getTime() + this.purgeRetryMs;
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

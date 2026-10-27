import { activeSourceVersion } from "@/auto-routing/signals";
import config from "@/config";
import logger from "@/logging";
import AutoRoutingDispatchModel from "@/models/auto-routing-dispatch";
import RoutingBackfillModel from "@/models/routing-backfill";
import RoutingDecisionModel from "@/models/routing-decision";
import RoutingHistoryModel from "@/models/routing-history";
import { HISTORY_MS } from "@/models/routing-usage";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Enqueues a fit for every organization whose plan is due — settings changed
 * since its last fit outcome, or no outcome for a day — resumes a backfill
 * whose worker died, and purges expired routing history once a day per
 * process.
 */
class AutoRoutingDispatcher {
  private lastPurgeAt: number | null = null;

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
    if (this.lastPurgeAt !== null && now.getTime() - this.lastPurgeAt < DAY_MS)
      return;
    try {
      const purged = {
        ...(await RoutingDecisionModel.purgeExpired(now)),
        past: await RoutingHistoryModel.purgeExpired({
          windowStart: new Date(now.getTime() - HISTORY_MS),
          keepScorerVersionId: (await activeSourceVersion()).id,
        }),
      };
      this.lastPurgeAt = now.getTime();
      logger.info(purged, "[AutoRouting] Purged expired routing history");
    } catch (error) {
      logger.error(
        { err: error },
        "[AutoRouting] Purging expired routing history failed",
      );
    }
  }
}

export const autoRoutingDispatcher = new AutoRoutingDispatcher();

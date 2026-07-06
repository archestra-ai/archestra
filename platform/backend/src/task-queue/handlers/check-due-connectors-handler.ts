import { Cron } from "croner";
import config from "@/config";
import logger from "@/logging";
import {
  ConnectorRunModel,
  KnowledgeBaseConnectorModel,
  TaskModel,
} from "@/models";
import { taskQueueService } from "@/task-queue";

// Window over which the crash-loop circuit breaker counts a connector's runs.
// The threshold itself is derived from the lease/work-budget params — see
// maxRunsPerResumeWindow() at the bottom of this file.
const RESUME_WINDOW_SECONDS = 60 * 60; // 1 hour

export async function handleCheckDueConnectors(): Promise<void> {
  const connectors = await KnowledgeBaseConnectorModel.findAllEnabled();
  // One query instead of a per-connector EXISTS check.
  const activeConnectorIds = await TaskModel.findActivePayloadValues(
    "connector_sync",
    "connectorId",
  );

  for (const connector of connectors) {
    if (!connector.schedule) continue;

    try {
      const cron = new Cron(connector.schedule);
      const nextRun = cron.nextRun(connector.lastSyncAt ?? new Date(0));

      if (nextRun && nextRun <= new Date()) {
        if (!activeConnectorIds.has(connector.id)) {
          await taskQueueService.enqueue({
            taskType: "connector_sync",
            payload: { connectorId: connector.id },
          });
          logger.info(
            {
              connectorId: connector.id,
              connectorName: connector.name,
              connectorType: connector.connectorType,
            },
            "Enqueued scheduled connector sync",
          );
        }
      }
    } catch (error) {
      logger.warn(
        {
          connectorId: connector.id,
          connectorName: connector.name,
          connectorType: connector.connectorType,
          schedule: connector.schedule,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to evaluate connector schedule",
      );
    }
  }

  await reapExpiredRuns();
  await cleanupOrphanedRunningStatuses();
}

/**
 * Reclaim connector runs whose liveness lease has lapsed. Liveness spans both
 * phases of a run: during ingest the owning worker renews the lease via a
 * heartbeat; during embedding drain, pending/processing `batch_embedding` tasks
 * ARE the liveness signal (reapExpiredRuns skips any run that still has embedding
 * work queued). So a run is only reclaimed when its lease lapsed AND it has no
 * embedding work left, which reliably means the worker died or hung — never a
 * healthy run mid-drain. (This fixes the old advisory-lock reaper, which reaped
 * healthy runs whose lock was released at end-of-ingest while embeddings — and
 * therefore the run — were still legitimately in progress.)
 *
 * A lease-expired run is marked `partial` and resumed from its checkpoint — it
 * did not drain its source, so reporting it complete would strand the remainder
 * — unless the connector is crash-looping. There is no separate time-based
 * hard-fail: a live run is bounded by the sync work budget (it checkpoints and
 * continues), and a dead/hung worker is caught by the lease expiry here.
 */
async function reapExpiredRuns(): Promise<void> {
  // Lease-expired runs with no embedding work left → interrupted → resume.
  const expired = await ConnectorRunModel.reapExpiredRuns();
  for (const run of expired) {
    logger.warn(
      { runId: run.id, connectorId: run.connectorId },
      "Reclaimed connector run with an expired lease; resuming from checkpoint",
    );
    await KnowledgeBaseConnectorModel.markReapedStatusIfCurrent({
      connectorId: run.connectorId,
      runId: run.id,
      status: "partial",
      error: null,
    });

    const recentRuns = await ConnectorRunModel.countRunsSince(
      run.connectorId,
      RESUME_WINDOW_SECONDS,
    );
    if (recentRuns > maxRunsPerResumeWindow()) {
      // Crash-looping: stop auto-resuming to avoid a runaway. A scheduled
      // connector retries on its next cron; a scheduleless one stays `partial`
      // (checkpoint preserved) until manually re-triggered — it needs a look.
      logger.error(
        { connectorId: run.connectorId, recentRuns },
        "Connector sync is repeatedly interrupted; not auto-resuming — needs investigation",
      );
      continue;
    }

    // Enqueue a continuation. A duplicate is harmless: claim() enforces
    // single-flight, so any redundant sync task simply skips.
    await taskQueueService.enqueue({
      taskType: "connector_sync",
      payload: { connectorId: run.connectorId },
    });
  }
}

async function cleanupOrphanedRunningStatuses(): Promise<void> {
  const stuckConnectors =
    await KnowledgeBaseConnectorModel.findAllWithStatus("running");
  if (stuckConnectors.length === 0) return;

  // Re-fetched here (not reused from the due-check) so tasks enqueued above
  // are visible and their connectors are not treated as orphaned.
  const activeConnectorIds = await TaskModel.findActivePayloadValues(
    "connector_sync",
    "connectorId",
  );

  for (const connector of stuckConnectors) {
    try {
      if (activeConnectorIds.has(connector.id)) continue;

      const hasRun = await ConnectorRunModel.hasActiveRun(connector.id);
      if (hasRun) continue;

      await KnowledgeBaseConnectorModel.update(connector.id, {
        lastSyncStatus: "failed",
        lastSyncError: "Sync task was lost",
      });
      logger.warn(
        {
          connectorId: connector.id,
          connectorName: connector.name,
          connectorType: connector.connectorType,
        },
        "Reset orphaned running status to failed",
      );
    } catch (error) {
      logger.warn(
        {
          connectorId: connector.id,
          connectorName: connector.name,
          connectorType: connector.connectorType,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to cleanup orphaned running status",
      );
    }
  }
}

/**
 * How many runs a connector may produce within RESUME_WINDOW_SECONDS before the
 * reaper stops auto-resuming it (treating it as crash-looping). Derived from the
 * lease/work-budget params so it stays meaningful when they are tuned, rather
 * than being a magic number:
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

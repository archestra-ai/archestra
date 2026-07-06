import { Cron } from "croner";
import config from "@/config";
import logger from "@/logging";
import {
  ConnectorRunModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
  TaskModel,
} from "@/models";
import { taskQueueService } from "@/task-queue";
import { withinResumeBudget } from "./connector-resume-budget";

// Bound the work one recovery sweep enqueues.
const EMBEDDING_RECOVERY_SWEEP_LIMIT = 500;
const EMBEDDING_RECOVERY_BATCH_SIZE = 100;

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
  await reconcileOrphanedConnectors();
  await recoverStalledEmbeddings();
}

/**
 * Reclaim connector runs whose liveness lease has lapsed and resume them from
 * their checkpoint. Liveness is uniform across a run's whole life: the owning
 * worker renews the lease during ingest (the heartbeat) and any worker renews it
 * per batch during the embedding-drain phase, so an expired lease reliably means
 * the run's worker crashed or hung — never a healthy run mid-drain. There is no
 * separate time-based hard-fail: a live run is bounded by the sync work budget
 * (it checkpoints and continues), a dead one is caught by lease expiry here.
 *
 * A reclaimed run is marked `partial` and resumed unless the connector is over
 * its run budget for the window (a runaway) — the SAME budget that bounds
 * time-budget chunk continuations, so chunking and reaping cannot between them
 * drive an unbounded run loop.
 */
async function reapExpiredRuns(): Promise<void> {
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

    if (!(await withinResumeBudget(run.connectorId))) {
      // Runaway: stop auto-resuming. A scheduled connector retries on its next
      // cron; a scheduleless one stays `partial` (checkpoint preserved) until
      // manually re-triggered — it needs a look.
      logger.error(
        { connectorId: run.connectorId },
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

/**
 * Fix connectors left showing `running` when they have no running run (e.g. a
 * finalized run whose connector-status write was lost). Derives each from its
 * latest run in one statement — no task scan, no per-connector loop.
 */
async function reconcileOrphanedConnectors(): Promise<void> {
  const corrected =
    await KnowledgeBaseConnectorModel.reconcileOrphanedConnectorStatuses();
  if (corrected.length > 0) {
    logger.warn(
      { connectorIds: corrected },
      "Reconciled connectors stuck in 'running' to their latest run status",
    );
  }
}

/**
 * Re-embed documents whose embedding stalled (a `batch_embedding` task died
 * terminally, so they sit at `pending`/`processing` forever and the advanced
 * sync checkpoint won't re-surface them). Enqueued with `connectorRunId: null`
 * so they embed without run bookkeeping; the embedder skips any that finished in
 * the meantime, so a redundant enqueue is harmless.
 */
async function recoverStalledEmbeddings(): Promise<void> {
  const documentIds = await KbDocumentModel.recoverStalledEmbeddings({
    olderThanSeconds: config.kb.stalledEmbeddingAgeSeconds,
    limit: EMBEDDING_RECOVERY_SWEEP_LIMIT,
  });
  if (documentIds.length === 0) return;

  logger.warn(
    { count: documentIds.length },
    "Re-enqueuing embedding for stalled documents",
  );
  for (let i = 0; i < documentIds.length; i += EMBEDDING_RECOVERY_BATCH_SIZE) {
    await taskQueueService.enqueue({
      taskType: "batch_embedding",
      payload: {
        documentIds: documentIds.slice(i, i + EMBEDDING_RECOVERY_BATCH_SIZE),
        connectorRunId: null,
      },
    });
  }
}

import {
  embeddingService,
  enqueuePermissionSyncAfterContentSync,
} from "@/knowledge-base";
import logger from "@/logging";
import { ConnectorRunModel, KnowledgeBaseConnectorModel } from "@/models";
import * as metrics from "@/observability/metrics";

export async function handleBatchEmbedding(
  payload: Record<string, unknown>,
): Promise<void> {
  const documentIds = payload.documentIds as string[];
  const connectorRunId = (payload.connectorRunId as string | null) ?? null;

  if (!documentIds?.length) {
    throw new Error("Missing documentIds in batch_embedding payload");
  }

  // The run's lease is intentionally NOT renewed here. During the drain phase the
  // liveness signal is the existence of pending/processing batch_embedding tasks,
  // not the lease — the reaper (reapExpiredRuns) skips any run that still has
  // embedding work queued. A lease renewal here would only cover batches being
  // *processed*, not ones still queued behind a backlog, so it can't stand in for
  // that check; the task-existence signal is what keeps a slow drain alive.

  let outcome: Awaited<ReturnType<typeof embeddingService.processDocuments>>;
  try {
    outcome = await embeddingService.processDocuments(
      documentIds,
      connectorRunId ?? undefined,
    );
    metrics.rag.reportEmbeddingBatch({
      documentCount: documentIds.length,
      status: outcome.failedDocumentCount > 0 ? "error" : "success",
    });
  } catch (error) {
    // processDocuments records per-document failures itself; a throw here is an
    // unexpected fault (e.g. the database is down) — let the task queue retry it.
    metrics.rag.reportEmbeddingBatch({
      documentCount: documentIds.length,
      status: "error",
    });
    throw error;
  }

  if (!connectorRunId) {
    return;
  }

  // Record any embedding failures on the connector run atomically with the batch
  // completion, so the failure's cause is visible in the run (not just the logs).
  const updatedRun = await ConnectorRunModel.completeBatch(
    connectorRunId,
    outcome.failedDocumentCount > 0
      ? {
          failedItems: outcome.failedDocumentCount,
          error: outcome.errorMessage ?? "Embedding failed",
        }
      : undefined,
  );

  // If all batches are done, update the connector's sync status.
  // Skip if run was superseded/failed — a newer run owns the connector status.
  // Also guard against a newer run having claimed the connector since this run
  // started: if connector.lastSyncAt > run.startedAt, a newer run has
  // optimistically written its own startedAt and we must not overwrite it.
  if (
    updatedRun &&
    updatedRun.completedBatches !== null &&
    updatedRun.totalBatches !== null &&
    updatedRun.completedBatches >= updatedRun.totalBatches &&
    (updatedRun.status === "success" ||
      updatedRun.status === "completed_with_errors")
  ) {
    const connector = await KnowledgeBaseConnectorModel.findById(
      updatedRun.connectorId,
    );
    const newerRunStarted =
      connector?.lastSyncAt != null &&
      connector.lastSyncAt > updatedRun.startedAt;

    if (!newerRunStarted) {
      const now = new Date();
      await KnowledgeBaseConnectorModel.update(updatedRun.connectorId, {
        lastSyncStatus: updatedRun.status,
        lastSyncAt: now,
      });
      logger.info(
        { runId: connectorRunId, connectorId: updatedRun.connectorId },
        "[BatchEmbeddingHandler] All batches complete, connector run finalized",
      );
      // Content trigger: a completed documents sync of an auto-sync
      // connector enqueues a (de-duped) permission pass so new documents are
      // tagged promptly instead of waiting for the next scheduled tick.
      if (connector) {
        await enqueuePermissionSyncAfterContentSync({
          connector,
          documentsIngested: updatedRun.documentsIngested ?? 0,
        });
      }
    } else {
      logger.info(
        {
          runId: connectorRunId,
          connectorId: updatedRun.connectorId,
          runStartedAt: updatedRun.startedAt,
          connectorLastSyncAt: connector?.lastSyncAt,
        },
        "[BatchEmbeddingHandler] Skipping connector update — newer run has started",
      );
    }
  }
}

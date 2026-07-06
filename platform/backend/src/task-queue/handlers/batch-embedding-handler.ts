import config from "@/config";
import { embeddingService } from "@/knowledge-base";
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

  // Drain-phase liveness: renew the run's lease so a healthy run draining its
  // embedding backlog stays "alive" to claim()/the reaper (both treat an expired
  // lease as a dead worker). Renew BEFORE the embed so the fresh TTL also covers
  // this batch's work. Keyed on status='running', so a reclaimed/finalized run
  // is never revived. This is what makes liveness uniform across ingest + drain
  // and lets the reaper avoid scanning the tasks table.
  if (connectorRunId) {
    await ConnectorRunModel.renewLeaseForRun({
      runId: connectorRunId,
      leaseTtlSeconds: config.kb.connectorRunLeaseTtlSeconds,
    });
  }

  try {
    await embeddingService.processDocuments(
      documentIds,
      connectorRunId ?? undefined,
    );
    metrics.rag.reportEmbeddingBatch({
      documentCount: documentIds.length,
      status: "success",
    });
  } catch (error) {
    metrics.rag.reportEmbeddingBatch({
      documentCount: documentIds.length,
      status: "error",
    });
    throw error;
  }

  if (!connectorRunId) {
    return;
  }

  const updatedRun = await ConnectorRunModel.completeBatch(connectorRunId);

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

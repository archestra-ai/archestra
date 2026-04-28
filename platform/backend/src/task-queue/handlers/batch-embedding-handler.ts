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

  if (
    updatedRun &&
    updatedRun.completedBatches !== null &&
    updatedRun.totalBatches !== null &&
    updatedRun.completedBatches >= updatedRun.totalBatches &&
    (updatedRun.status === "success" ||
      updatedRun.status === "completed_with_errors")
  ) {
    const now = new Date();
    await KnowledgeBaseConnectorModel.update(updatedRun.connectorId, {
      lastSyncStatus: updatedRun.status,
      lastSyncAt: now,
    });
    logger.info(
      { runId: connectorRunId, connectorId: updatedRun.connectorId },
      "[BatchEmbeddingHandler] All batches complete, connector run finalized",
    );
  }
}

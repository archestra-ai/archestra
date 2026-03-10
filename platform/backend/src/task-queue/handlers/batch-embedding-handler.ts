import { embeddingService } from "@/knowledge-base";
import logger from "@/logging";
import { ConnectorRunModel, KnowledgeBaseConnectorModel } from "@/models";

export async function handleBatchEmbedding(
  payload: Record<string, unknown>,
): Promise<void> {
  const documentIds = payload.documentIds as string[];
  const connectorRunId = payload.connectorRunId as string;

  if (!documentIds?.length || !connectorRunId) {
    throw new Error(
      "Missing documentIds or connectorRunId in batch_embedding payload",
    );
  }

  await embeddingService.processDocuments(documentIds, connectorRunId);

  const updatedRun = await ConnectorRunModel.completeBatch(connectorRunId);

  // If all batches are done, update the connector's sync status
  // Skip if run was superseded/failed — a newer run owns the connector status
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

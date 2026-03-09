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

  await embeddingService.processDocuments(documentIds);

  const updatedRun = await ConnectorRunModel.completeBatch(connectorRunId);

  // If all batches are done, update the connector's sync status
  if (
    updatedRun &&
    updatedRun.completedBatches !== null &&
    updatedRun.totalBatches !== null &&
    updatedRun.completedBatches >= updatedRun.totalBatches
  ) {
    const now = new Date();
    await KnowledgeBaseConnectorModel.update(updatedRun.connectorId, {
      lastSyncStatus: "success",
      lastSyncAt: now,
    });
    logger.info(
      { connectorRunId, connectorId: updatedRun.connectorId },
      "[BatchEmbeddingHandler] All batches complete, connector run finalized",
    );
  }
}

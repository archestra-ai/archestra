import { enqueuePermissionSyncAfterContentSync } from "@/knowledge-base";
import logger from "@/logging";
import { ConnectorRunModel, KnowledgeBaseConnectorModel } from "@/models";

type CompletedBatchRun = Awaited<
  ReturnType<typeof ConnectorRunModel.completeBatch>
>;

/**
 * Mirrors a drained connector run to the connector and triggers the deduped
 * follow-documents permission pass. Both the normal handler and terminal
 * dead-letter path use this so a last-batch failure cannot skip finalization.
 */
export async function finalizeConnectorAfterEmbeddingDrain(
  updatedRun: CompletedBatchRun,
): Promise<void> {
  if (
    !updatedRun ||
    updatedRun.completedBatches === null ||
    updatedRun.totalBatches === null ||
    updatedRun.completedBatches < updatedRun.totalBatches ||
    (updatedRun.status !== "success" &&
      updatedRun.status !== "completed_with_errors")
  ) {
    return;
  }

  const connector = await KnowledgeBaseConnectorModel.findById(
    updatedRun.connectorId,
  );
  const [latestRun] = await ConnectorRunModel.findByConnector({
    connectorId: updatedRun.connectorId,
    limit: 1,
  });
  const newerRunStarted =
    latestRun != null &&
    latestRun.id !== updatedRun.id &&
    latestRun.startedAt > updatedRun.startedAt;

  if (newerRunStarted) {
    logger.info(
      {
        runId: updatedRun.id,
        connectorId: updatedRun.connectorId,
        runStartedAt: updatedRun.startedAt,
        newerRunId: latestRun.id,
        newerRunStartedAt: latestRun.startedAt,
      },
      "[BatchEmbeddingFinalizer] Skipping connector update — newer run has started",
    );
    return;
  }

  await KnowledgeBaseConnectorModel.update(updatedRun.connectorId, {
    lastSyncStatus: updatedRun.status,
    lastSyncAt: updatedRun.completedAt ?? new Date(),
  });
  logger.info(
    { runId: updatedRun.id, connectorId: updatedRun.connectorId },
    "[BatchEmbeddingFinalizer] All batches complete, connector run finalized",
  );

  if (connector) {
    await enqueuePermissionSyncAfterContentSync({
      connector,
      documentsIngested: updatedRun.documentsIngested ?? 0,
    });
  }
}

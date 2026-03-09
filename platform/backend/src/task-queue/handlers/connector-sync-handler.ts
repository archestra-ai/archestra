import config from "@/config";
import { createCapturingLogger } from "@/entrypoints/_shared/log-capture";
import { connectorSyncService } from "@/knowledge-base";
import logger from "@/logging";
import { taskQueueService } from "@/task-queue";

const MAX_CONTINUATIONS = 50;

export async function handleConnectorSync(
  payload: Record<string, unknown>,
): Promise<void> {
  const connectorId = payload.connectorId as string;
  const continuationCount = (payload.continuationCount as number) ?? 0;

  if (!connectorId) {
    throw new Error("Missing connectorId in connector_sync payload");
  }

  const { logger: capturingLogger, getLogOutput } = createCapturingLogger();

  const maxDurationMs = config.kb.connectorSyncMaxDurationSeconds
    ? config.kb.connectorSyncMaxDurationSeconds * 1000
    : undefined;

  const result = await connectorSyncService.executeSync(connectorId, {
    logger: capturingLogger,
    getLogOutput,
    maxDurationMs,
  });

  // On partial result, enqueue a continuation
  if (result.status === "partial") {
    if (continuationCount < MAX_CONTINUATIONS) {
      await taskQueueService.enqueue({
        taskType: "connector_sync",
        payload: {
          connectorId,
          continuationCount: continuationCount + 1,
        },
      });
      logger.info(
        { connectorId, continuationCount: continuationCount + 1 },
        "[ConnectorSyncHandler] Enqueued continuation",
      );
    } else {
      logger.warn(
        { connectorId, maxContinuations: MAX_CONTINUATIONS },
        "[ConnectorSyncHandler] Max continuations reached",
      );
    }
  }
}

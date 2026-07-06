import config from "@/config";
import { createCapturingLogger } from "@/entrypoints/_shared/log-capture";
import { connectorSyncService } from "@/knowledge-base";
import logger from "@/logging";
import { KnowledgeBaseConnectorModel } from "@/models";
import { taskQueueService } from "@/task-queue";
import { withinResumeBudget } from "./connector-resume-budget";

export async function handleConnectorSync(
  payload: Record<string, unknown>,
): Promise<void> {
  const connectorId = payload.connectorId as string;

  if (!connectorId) {
    throw new Error("Missing connectorId in connector_sync payload");
  }

  // Load connector metadata for structured logging
  const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
  const connectorName = connector?.name;
  const connectorType = connector?.connectorType;

  const { logger: capturingLogger, getLogOutput } = createCapturingLogger();

  // A run works up to ~90% of this budget, then checkpoints and enqueues a
  // continuation (marked `partial`) that resumes from the checkpoint. Unset
  // (disabled) means the run goes to completion in a single pass.
  const maxDurationMs = config.kb.connectorSyncMaxDurationSeconds
    ? config.kb.connectorSyncMaxDurationSeconds * 1000
    : undefined;

  const result = await connectorSyncService.executeSync(connectorId, {
    logger: capturingLogger,
    getLogOutput,
    maxDurationMs,
  });

  // On a partial (time-budget) result, enqueue a continuation — unless the
  // connector has exceeded its run budget for the window (a runaway). The same
  // budget bounds reaper-driven resumes, so chunking and reaping can't between
  // them drive a connector into an unbounded run loop.
  if (result.status === "partial") {
    if (await withinResumeBudget(connectorId)) {
      await taskQueueService.enqueue({
        taskType: "connector_sync",
        payload: { connectorId },
      });
      logger.info(
        { connectorId, connectorName, connectorType, runId: result.runId },
        "Enqueued sync continuation",
      );
    } else {
      logger.warn(
        { connectorId, connectorName, connectorType, runId: result.runId },
        "Connector exceeded its run budget for the window; not continuing until next schedule",
      );
    }
  }
}

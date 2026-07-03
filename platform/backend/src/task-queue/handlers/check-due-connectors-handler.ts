import { Cron } from "croner";
import logger from "@/logging";
import {
  ConnectorRunModel,
  KnowledgeBaseConnectorModel,
  TaskModel,
} from "@/models";
import { taskQueueService } from "@/task-queue";

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

  await cleanupOrphanedRunningStatuses();
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

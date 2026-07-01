import config from "@/config";
import { getConnector } from "@/knowledge-base/connectors/registry";
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

  for (const connector of connectors) {
    try {
      if (connector.schedule) {
        const cron = new Cron(connector.schedule);
        const nextRun = cron.nextRun(connector.lastSyncAt ?? new Date(0));

        if (nextRun && nextRun <= new Date()) {
          const exists = await TaskModel.hasPendingOrProcessing(
            ["connector_sync", "connector_prune"],
            connector.id,
          );
          if (!exists) {
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
      }

      const connectorImpl = getConnector(connector.connectorType);
      const pruneSupported = typeof connectorImpl.listAllSourceIds === "function";
      const pruneDueAt = new Date(
        (connector.lastPruneAt ?? new Date(0)).getTime() +
          config.kb.connectorPruneIntervalSeconds * 1000,
      );

      if (pruneSupported && pruneDueAt <= new Date()) {
        const pruneExists = await TaskModel.hasPendingOrProcessing(
          ["connector_sync", "connector_prune"],
          connector.id,
        );
        if (!pruneExists) {
          await taskQueueService.enqueue({
            taskType: "connector_prune",
            payload: { connectorId: connector.id },
          });
          logger.info(
            {
              connectorId: connector.id,
              connectorName: connector.name,
              connectorType: connector.connectorType,
            },
            "Enqueued scheduled connector prune",
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

  for (const connector of stuckConnectors) {
    try {
      const hasPendingTask = await TaskModel.hasPendingOrProcessing(
        ["connector_sync", "connector_prune"],
        connector.id,
      );
      if (hasPendingTask) continue;

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

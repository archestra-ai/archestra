import { Cron } from "croner";
import logger from "@/logging";
import { KnowledgeBaseConnectorModel, TaskModel } from "@/models";
import { taskQueueService } from "@/task-queue";

export async function handleCheckDueConnectors(): Promise<void> {
  const connectors = await KnowledgeBaseConnectorModel.findAllEnabled();

  for (const connector of connectors) {
    if (!connector.schedule) continue;

    try {
      const cron = new Cron(connector.schedule);
      const nextRun = cron.nextRun(connector.lastSyncAt ?? new Date(0));

      if (nextRun && nextRun <= new Date()) {
        const exists = await TaskModel.hasPendingOrProcessing(
          "connector_sync",
          connector.id,
        );
        if (!exists) {
          await taskQueueService.enqueue({
            taskType: "connector_sync",
            payload: { connectorId: connector.id },
          });
          logger.info(
            { connectorId: connector.id },
            "[TaskQueue] Enqueued scheduled connector sync",
          );
        }
      }
    } catch (error) {
      logger.warn(
        {
          connectorId: connector.id,
          schedule: connector.schedule,
          error: error instanceof Error ? error.message : String(error),
        },
        "[TaskQueue] Failed to evaluate connector schedule",
      );
    }
  }
}

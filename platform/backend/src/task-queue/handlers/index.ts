import type { TaskQueueService } from "../task-queue";
import { handleBatchEmbedding } from "./batch-embedding-handler";
import { handleConnectorSync } from "./connector-sync-handler";

export function registerTaskHandlers(
  taskQueueService: TaskQueueService,
): void {
  taskQueueService.registerHandler("connector_sync", handleConnectorSync);
  taskQueueService.registerHandler("batch_embedding", handleBatchEmbedding);
}

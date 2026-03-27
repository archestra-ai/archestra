import type { TaskQueueService } from "../task-queue";
import { handleAgentTrigger } from "./agent-trigger-handler";
import { handleBatchEmbedding } from "./batch-embedding-handler";
import { handleCheckDueAgents } from "./check-due-agents-handler";
import { handleCheckDueConnectors } from "./check-due-connectors-handler";
import { handleConnectorSync } from "./connector-sync-handler";

export function registerTaskHandlers(taskQueueService: TaskQueueService): void {
  taskQueueService.registerHandler("connector_sync", handleConnectorSync);
  taskQueueService.registerHandler("batch_embedding", handleBatchEmbedding);
  taskQueueService.registerHandler(
    "check_due_connectors",
    handleCheckDueConnectors,
  );
  taskQueueService.registerHandler("agent_trigger", handleAgentTrigger);
  taskQueueService.registerHandler("check_due_agents", handleCheckDueAgents);
}

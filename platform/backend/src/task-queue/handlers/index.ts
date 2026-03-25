import type { TaskQueueService } from "../task-queue";
import { handleBatchEmbedding } from "./batch-embedding-handler";
import { handleCheckDueConnectors } from "./check-due-connectors-handler";
import {
  handleCheckDueAgentSchedules,
  handleExecuteAgentScheduleTrigger,
} from "./check-due-agent-schedules-handler";
import { handleConnectorSync } from "./connector-sync-handler";

export function registerTaskHandlers(taskQueueService: TaskQueueService): void {
  taskQueueService.registerHandler("connector_sync", handleConnectorSync);
  taskQueueService.registerHandler("batch_embedding", handleBatchEmbedding);
  taskQueueService.registerHandler(
    "check_due_connectors",
    handleCheckDueConnectors,
  );
  taskQueueService.registerHandler(
    "check_due_agent_schedules",
    handleCheckDueAgentSchedules,
  );
  taskQueueService.registerHandler(
    "execute_agent_schedule_trigger",
    handleExecuteAgentScheduleTrigger,
  );
}

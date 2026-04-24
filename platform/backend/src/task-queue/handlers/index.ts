import type { TaskQueueService } from "../task-queue";
import { handleAssignAgentToolsFromLabels } from "./assign-agent-tools-from-labels-handler";
import { handleAssignAgentToolsFromLabelsForAgent } from "./assign-agent-tools-from-labels-for-agent-handler";
import { handleBatchEmbedding } from "./batch-embedding-handler";
import { handleCheckDueConnectors } from "./check-due-connectors-handler";
import { handleCheckDueScheduleTriggers } from "./check-due-schedule-triggers-handler";
import { handleConnectorSync } from "./connector-sync-handler";
import { handleScheduleTriggerRunExecution } from "./schedule-trigger-run-handler";

export function registerTaskHandlers(taskQueueService: TaskQueueService): void {
  taskQueueService.registerHandler("connector_sync", handleConnectorSync);
  taskQueueService.registerHandler("batch_embedding", handleBatchEmbedding);
  taskQueueService.registerHandler(
    "check_due_connectors",
    handleCheckDueConnectors,
  );
  taskQueueService.registerHandler(
    "check_due_schedule_triggers",
    handleCheckDueScheduleTriggers,
  );
  taskQueueService.registerHandler(
    "schedule_trigger_run_execute",
    handleScheduleTriggerRunExecution,
  );
  taskQueueService.registerHandler(
    "assign_agent_tools_from_labels",
    handleAssignAgentToolsFromLabels,
  );
  taskQueueService.registerHandler(
    "assign_agent_tools_from_labels_for_agent",
    handleAssignAgentToolsFromLabelsForAgent,
  );
}

import logger from "@/logging";
import { AgentModel, TaskModel } from "@/models";
import { taskQueueService } from "@/task-queue";

export async function handleAssignAgentToolsFromLabels(): Promise<void> {
  const agentIds = await AgentModel.findAllAutomaticMcpGatewayIds();

  let enqueued = 0;
  let skipped = 0;

  for (const agentId of agentIds) {
    const alreadyQueued = await TaskModel.hasPendingOrProcessingForAgent(
      "assign_agent_tools_from_labels_for_agent",
      agentId,
    );

    if (alreadyQueued) {
      skipped++;
      continue;
    }

    await taskQueueService.enqueue({
      taskType: "assign_agent_tools_from_labels_for_agent",
      payload: { agentId },
    });
    enqueued++;
  }

  logger.info(
    { total: agentIds.length, enqueued, skipped },
    "Fanout enqueued per-agent tool reconciliation tasks",
  );
}

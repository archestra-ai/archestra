import { watchTaskCompletion } from "@/agents/task-completion-watcher";
import type { AgentRunCompletionTarget } from "@/types";

export async function watchChatOpsTask(params: {
  taskId: string;
  bindingId: string;
  threadId: string;
  agentName: string;
  appaSession?: Extract<
    AgentRunCompletionTarget,
    { type: "chatops" }
  >["appaSession"];
  deliveryOrigin?: Extract<
    AgentRunCompletionTarget,
    { type: "chatops" }
  >["deliveryOrigin"];
}): Promise<void> {
  return watchTaskCompletion({
    taskId: params.taskId,
    agentName: params.agentName,
    target: {
      type: "chatops",
      bindingId: params.bindingId,
      threadId: params.threadId,
      ...(params.appaSession ? { appaSession: params.appaSession } : {}),
      ...(params.deliveryOrigin
        ? { deliveryOrigin: params.deliveryOrigin }
        : {}),
    },
  });
}

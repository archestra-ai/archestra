import { watchTaskCompletion } from "@/agents/task-completion-watcher";

export async function watchChatOpsTask(params: {
  taskId: string;
  bindingId: string;
  threadId: string;
  agentName: string;
}): Promise<void> {
  return watchTaskCompletion({
    taskId: params.taskId,
    agentName: params.agentName,
    target: {
      type: "chatops",
      bindingId: params.bindingId,
      threadId: params.threadId,
    },
  });
}

import { watchTaskCompletion } from "@/agents/task-completion-watcher";

export async function watchChatOpsTask(params: {
  taskId: string;
  bindingId: string;
  threadId: string;
  agentName: string;
  pinnedAgentId?: string;
  conversationReference?: Record<string, unknown>;
  originatingTaskId?: string;
  placeholderActivityId?: string;
  muteMarkerAtStart?: string | null;
}): Promise<void> {
  return watchTaskCompletion({
    taskId: params.taskId,
    agentName: params.agentName,
    target: {
      type: "chatops",
      bindingId: params.bindingId,
      threadId: params.threadId,
      ...(params.pinnedAgentId && { pinnedAgentId: params.pinnedAgentId }),
      ...(params.conversationReference && {
        conversationReference: params.conversationReference,
      }),
      ...(params.originatingTaskId && {
        originatingTaskId: params.originatingTaskId,
      }),
      ...(params.placeholderActivityId && {
        placeholderActivityId: params.placeholderActivityId,
      }),
      ...(params.muteMarkerAtStart !== undefined && {
        muteMarkerAtStart: params.muteMarkerAtStart,
      }),
    },
  });
}

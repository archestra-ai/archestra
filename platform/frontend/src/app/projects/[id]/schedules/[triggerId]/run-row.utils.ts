export type RunRowKind = "open-chat" | "open-runtime" | "resolve" | "running";

// Runtime tasks and chats open their existing session. Completed legacy runs
// resolve a chat lazily; unlinked runs still being launched remain inert.
export function runRowKind(run: {
  status: string;
  chatConversationId: string | null;
  runtimeTaskId?: string | null;
}): RunRowKind {
  if (run.runtimeTaskId) return "open-runtime";
  if (run.chatConversationId) {
    return "open-chat";
  }
  if (run.status !== "running") {
    return "resolve";
  }
  return "running";
}

// Open the runtime directly, or a chat carrying its scheduled-run context.
export function runHref(params: {
  triggerId: string;
  run: {
    id: string;
    status: string;
    chatConversationId: string | null;
    runtimeTaskId?: string | null;
  };
}): string | null {
  if (params.run.runtimeTaskId) return `/chat/runs/${params.run.runtimeTaskId}`;
  if (runRowKind(params.run) !== "open-chat") {
    return null;
  }
  return `/chat/${params.run.chatConversationId}?scheduleTriggerId=${params.triggerId}&scheduleRunId=${params.run.id}`;
}

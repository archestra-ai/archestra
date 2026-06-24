export type RunRowKind = "open-chat" | "show-error" | "running";

// success WITH a conversation → "open-chat"; failed → "show-error";
// anything else (running, or success without a conversation yet) → "running".
export function runRowKind(run: {
  status: string;
  chatConversationId: string | null;
}): RunRowKind {
  if (run.status === "failed") {
    return "show-error";
  }
  if (run.status === "success" && run.chatConversationId) {
    return "open-chat";
  }
  return "running";
}

// Chat URL carrying schedule context for an openable run; null when not openable.
export function runChatHref(params: {
  projectId: string;
  triggerId: string;
  run: { id: string; status: string; chatConversationId: string | null };
}): string | null {
  if (runRowKind(params.run) !== "open-chat") {
    return null;
  }
  return `/chat/${params.run.chatConversationId}?scheduleTriggerId=${params.triggerId}&scheduleRunId=${params.run.id}`;
}

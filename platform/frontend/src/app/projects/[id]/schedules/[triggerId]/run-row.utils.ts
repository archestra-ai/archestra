export type RunRowKind = "open-chat" | "show-error" | "running";

// A COMPLETED run with a chat conversation → "open-chat": a succeeded run shows
// its transcript, a failed run shows an inline error card in that same chat
// (failed runs keep their conversation). A failed run WITHOUT a conversation
// (e.g. it never executed) → "show-error" (inline in the runs list). Anything
// in-progress, or a success without a conversation yet → "running".
export function runRowKind(run: {
  status: string;
  chatConversationId: string | null;
}): RunRowKind {
  if (run.status !== "success" && run.status !== "failed") {
    return "running";
  }
  if (run.chatConversationId) {
    return "open-chat";
  }
  if (run.status === "failed") {
    return "show-error";
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

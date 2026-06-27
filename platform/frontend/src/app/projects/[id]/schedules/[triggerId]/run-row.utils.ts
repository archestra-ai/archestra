export type RunRowKind = "open-chat" | "resolve" | "running";

// A run with a chat conversation → "open-chat": a Link straight to that chat (a
// succeeded run shows its transcript; a failed run shows the prompt + an inline
// error card with "Try again"). A COMPLETED run WITHOUT a conversation (legacy,
// predating eager creation) → "resolve": clicking it lazily creates the
// conversation, then opens it. Anything still in-flight without a conversation
// yet → "running" (inert).
export function runRowKind(run: {
  status: string;
  chatConversationId: string | null;
}): RunRowKind {
  if (run.chatConversationId) {
    return "open-chat";
  }
  if (run.status === "success" || run.status === "failed") {
    return "resolve";
  }
  return "running";
}

// Chat URL carrying schedule context for a run that already has a conversation;
// null when the run still needs one resolved first.
export function runChatHref(params: {
  triggerId: string;
  run: { id: string; status: string; chatConversationId: string | null };
}): string | null {
  if (runRowKind(params.run) !== "open-chat") {
    return null;
  }
  return `/chat/${params.run.chatConversationId}?scheduleTriggerId=${params.triggerId}&scheduleRunId=${params.run.id}`;
}

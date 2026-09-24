export function conversationHref(conversation: {
  id: string;
  origin?: string;
  scheduledRun?: { id: string; triggerId: string } | null;
}): string {
  if (conversation.scheduledRun) {
    return `/chat/${conversation.id}?scheduleTriggerId=${conversation.scheduledRun.triggerId}&scheduleRunId=${conversation.scheduledRun.id}`;
  }
  if (conversation.origin === "openappa") {
    return `/openappa/${encodeURIComponent(conversation.id)}`;
  }
  return `/chat/${conversation.id}`;
}

export function conversationHref(conversation: {
  id: string;
  scheduledRun?: { id: string; triggerId: string } | null;
}): string {
  if (conversation.scheduledRun) {
    return `/chat/${conversation.id}?scheduleTriggerId=${conversation.scheduledRun.triggerId}&scheduleRunId=${conversation.scheduledRun.id}`;
  }
  return `/chat/${conversation.id}`;
}

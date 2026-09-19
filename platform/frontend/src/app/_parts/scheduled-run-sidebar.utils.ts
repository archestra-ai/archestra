/**
 * Returns true if the conversation was created by a scheduled run
 * (`origin === "schedule_trigger"`), false otherwise.
 *
 * Used to identify scheduled runs in the sidebar and group them in project Recents.
 */
export function isScheduledRunConversation(c: { origin: string }): boolean {
  return c.origin === "schedule_trigger";
}

/** Keep one task entry, backed by its newest run, alongside normal chats. */
export function groupSidebarTasks<
  T extends {
    id: string;
    origin?: string;
    scheduledRun?: { triggerId: string; createdAt: string } | null;
  },
>(conversations: T[]): T[] {
  const latest = new Map<string, T>();
  for (const conversation of conversations) {
    const run = conversation.scheduledRun;
    if (!run) continue;
    const previous = latest.get(run.triggerId);
    if (
      !previous?.scheduledRun ||
      Date.parse(run.createdAt) > Date.parse(previous.scheduledRun.createdAt)
    ) {
      latest.set(run.triggerId, conversation);
    }
  }
  return conversations.filter((conversation) =>
    conversation.scheduledRun
      ? latest.get(conversation.scheduledRun.triggerId)?.id === conversation.id
      : conversation.origin !== "schedule_trigger",
  );
}

/**
 * The schedule context for the open conversation, read from the chat URL the
 * runs view links to (`/chat/<conv>?scheduleTriggerId=<t>&scheduleRunId=<r>`),
 * or null when the conversation isn't a scheduled run (no scheduleTriggerId).
 */
export function scheduledRunContext(
  searchParams: URLSearchParams,
): { triggerId: string; runId: string | null } | null {
  const triggerId = searchParams.get("scheduleTriggerId");
  if (!triggerId) {
    return null;
  }
  const runId = searchParams.get("scheduleRunId");
  return { triggerId, runId };
}

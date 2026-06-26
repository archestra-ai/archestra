/** Minimum shape needed to collapse a project's chat list. */
export type CollapsibleChat = {
  origin: "user" | "schedule_trigger";
  lastMessageAt: string;
  scheduleTriggerId: string | null;
};

/**
 * Collapse a project's chat list for display: keep every user chat, and collapse
 * each schedule's runs into a single row — the latest run by `lastMessageAt`.
 * Result is newest-activity first. A scheduled chat with no `scheduleTriggerId`
 * (shouldn't happen) falls back to showing individually rather than vanishing.
 */
export function collapseProjectChats<T extends CollapsibleChat>(
  conversations: T[],
): T[] {
  const latestByTrigger = new Map<string, T>();
  const kept: T[] = [];

  for (const conversation of conversations) {
    if (
      conversation.origin === "schedule_trigger" &&
      conversation.scheduleTriggerId
    ) {
      const previous = latestByTrigger.get(conversation.scheduleTriggerId);
      if (!previous || conversation.lastMessageAt > previous.lastMessageAt) {
        latestByTrigger.set(conversation.scheduleTriggerId, conversation);
      }
    } else {
      kept.push(conversation);
    }
  }

  return [...kept, ...latestByTrigger.values()].sort((a, b) => {
    if (a.lastMessageAt < b.lastMessageAt) return 1;
    if (a.lastMessageAt > b.lastMessageAt) return -1;
    return 0;
  });
}

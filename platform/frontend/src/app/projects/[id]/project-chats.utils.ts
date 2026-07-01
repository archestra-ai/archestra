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

/**
 * Count each schedule's runs within a project's chat list, keyed by trigger id.
 * A scheduled run is one `schedule_trigger` conversation, so the count is the
 * number of runs that produced an openable chat — what the collapsed Recents row
 * shows as "N runs".
 */
export function countRunsByTrigger<T extends CollapsibleChat>(
  conversations: T[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const conversation of conversations) {
    if (
      conversation.origin === "schedule_trigger" &&
      conversation.scheduleTriggerId
    ) {
      const id = conversation.scheduleTriggerId;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Title + meta strings for a collapsed scheduled row in the Recents list. The
 * title is prefixed with "Scheduled task" so the row reads as a schedule at a
 * glance; the meta line leads with the run count, then the run's prompt.
 */
export function formatScheduledRecentRow(params: {
  scheduleName: string | null;
  prompt: string | null;
  runCount: number;
}): { title: string; meta: string } {
  const { scheduleName, prompt, runCount } = params;
  const runs = `${runCount} ${runCount === 1 ? "run" : "runs"}`;
  return {
    title: scheduleName ? `Scheduled task · ${scheduleName}` : "Scheduled task",
    meta: `${runs} · ${prompt ?? "No prompt"}`,
  };
}

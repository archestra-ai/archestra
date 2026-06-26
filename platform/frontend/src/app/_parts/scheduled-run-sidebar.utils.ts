/**
 * Returns true if the conversation was created by a scheduled run
 * (`origin === "schedule_trigger"`), false otherwise.
 *
 * Scheduled-run conversations are surfaced only in the schedule's runs view and
 * must not appear in flat chat lists such as the project ChatsList or the main
 * sidebar Recents.
 */
export function isScheduledRunConversation(c: { origin: string }): boolean {
  return c.origin === "schedule_trigger";
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

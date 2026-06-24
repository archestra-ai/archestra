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

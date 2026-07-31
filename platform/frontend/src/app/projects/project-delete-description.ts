/**
 * Confirmation copy for deleting a project.
 *
 * A deleted project keeps what it owns: its files and scheduled tasks travel
 * with it into Deleted Items and come back intact if it is restored. Its chats
 * are the one exception — they detach and survive on their own, so they are not
 * restored with it either. Scheduled tasks stop running in the meantime, which
 * the dialog must say when the project owns any: silently pausing automation
 * would be a surprise.
 */
export function buildProjectDeleteDescription(scheduleCount: number): string {
  const base =
    "The project is moved to Deleted Items with its files, where it can be restored or removed for good. Its chats are kept as ordinary conversations and stay where they are.";
  if (scheduleCount <= 0) {
    return base;
  }
  const clause =
    scheduleCount === 1
      ? "Its 1 scheduled task stops running"
      : `Its ${scheduleCount} scheduled tasks stop running`;
  return `${base} ${clause} until the project is restored.`;
}

/**
 * Confirmation copy for deleting a project. Deleting a project cascades to its
 * scheduled tasks (and their run history), so when the project owns any, the
 * dialog must say so — silently stopping automation would be a surprise.
 */
export function buildProjectDeleteDescription(scheduleCount: number): string {
  const base =
    "Chats are kept as ordinary conversations. Project files are deleted with the project.";
  if (scheduleCount <= 0) {
    return base;
  }
  const clause =
    scheduleCount === 1
      ? "1 scheduled task and its run history"
      : `${scheduleCount} scheduled tasks and their run history`;
  return `${base} This also permanently deletes ${clause}.`;
}

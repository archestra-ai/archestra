type RunActivity = {
  state: string;
  endedAt: string | null;
  lastModelActivityAt?: string | null;
};

/**
 * A turn settles as Completed the moment its client reports the turn done,
 * but the interactive CLI behind it is retained and can keep working: queued
 * follow-ups, tool calls, or a person typing into the reattached terminal.
 * Those model requests still carry the run id, so model activity newer than
 * the run's end is the session itself saying it is still busy.
 */
export function hasRetainedSessionActivity(
  run: RunActivity,
  now = Date.now(),
): boolean {
  if (
    run.state !== "TASK_STATE_COMPLETED" ||
    !run.endedAt ||
    !run.lastModelActivityAt
  ) {
    return false;
  }
  const activityAt = new Date(run.lastModelActivityAt).getTime();
  return (
    activityAt > new Date(run.endedAt).getTime() &&
    now - activityAt < NO_MODEL_ACTIVITY_WARNING_MS
  );
}

/**
 * A run that ended within the activity window can still change: its retained
 * CLI may start calling the model again, or a continuation lands a new turn
 * whose row appears only after the continue request has returned.
 */
export function hasRecentlyEnded(
  run: Pick<RunActivity, "endedAt">,
  now = Date.now(),
): boolean {
  return (
    !!run.endedAt &&
    now - new Date(run.endedAt).getTime() < NO_MODEL_ACTIVITY_WARNING_MS
  );
}

/** How long a run may go without a model request before it reads as inactive. */
export const NO_MODEL_ACTIVITY_WARNING_MS = 15 * 60_000;

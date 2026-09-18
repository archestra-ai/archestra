type RunActivity = {
  state: string;
  endedAt: string | null;
  lastModelActivityAt?: string | null;
};

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

export function hasRecentlyEnded(
  run: Pick<RunActivity, "endedAt">,
  now = Date.now(),
): boolean {
  return (
    !!run.endedAt &&
    now - new Date(run.endedAt).getTime() < NO_MODEL_ACTIVITY_WARNING_MS
  );
}

export const NO_MODEL_ACTIVITY_WARNING_MS = 15 * 60_000;

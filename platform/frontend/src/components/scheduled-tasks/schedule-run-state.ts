import type { ScheduleTriggerRunStatus } from "@/lib/schedule-trigger.query";

// Run-state helpers without the cron parser: the chat page needs these on
// every load, the cron utilities only when a schedule is edited.

export function isScheduleTriggerRunActive(
  status: ScheduleTriggerRunStatus | null | undefined,
): boolean {
  return status === "running";
}

/**
 * Decides how the chat pane should present a conversation that backs a scheduled
 * run. Live output uses chat replay with the normal composer and Stop control.
 * `context` is the schedule context read
 * from the chat URL (null for an ordinary chat); `runStatus` is the pinned run's
 * status (undefined until it loads).
 */
export function getScheduledRunChatState(params: {
  context: { triggerId: string; runId: string | null } | null;
  runStatus: ScheduleTriggerRunStatus | null | undefined;
}): { isScheduledRunChat: boolean; isRunInProgress: boolean } {
  const isScheduledRunChat = params.context !== null;
  const isRunInProgress =
    isScheduledRunChat &&
    params.context?.runId != null &&
    isScheduleTriggerRunActive(params.runStatus);
  return { isScheduledRunChat, isRunInProgress };
}

import type { ScheduleTriggerRun } from "@/lib/schedule-trigger.query";

export function scheduleRunEventTime(run: ScheduleTriggerRun): string {
  return !run.blockedBy && run.status !== "running"
    ? (run.completedAt ?? run.createdAt)
    : run.createdAt;
}

export function scheduleRunTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function scheduleRunDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (!minutes) return "under 1 min";
  const hours = Math.floor(minutes / 60);
  return hours
    ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
    : `${minutes} min`;
}

export function scheduleRunOutcome(run: ScheduleTriggerRun): string {
  if (run.blockedBy) return "Scheduled run skipped";
  if (run.status === "running")
    return run.runtimeTaskId || run.chatConversationId
      ? "Run started"
      : "Run queued";
  return run.status === "cancelled"
    ? "Run stopped"
    : run.status === "success"
      ? "Run completed"
      : "Run failed";
}

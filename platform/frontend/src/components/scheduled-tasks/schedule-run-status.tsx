import { Check, Loader2, Minus, X } from "lucide-react";
import type { ScheduleTriggerRun } from "@/lib/schedule-trigger.query";
import { cn } from "@/lib/utils/tailwind";

export function scheduleRunLabel(run: ScheduleTriggerRun) {
  if (run.blockedBy) return "Skipped";
  if (run.status === "running")
    return run.chatConversationId || run.runtimeTaskId ? "Running" : "Queued";
  return { success: "Succeeded", failed: "Failed", cancelled: "Cancelled" }[
    run.status
  ];
}
export function ScheduleRunStatus({ run }: { run: ScheduleTriggerRun }) {
  const label = scheduleRunLabel(run);
  const Icon = run.blockedBy
    ? Minus
    : run.status === "success"
      ? Check
      : run.status === "failed"
        ? X
        : run.status === "running"
          ? Loader2
          : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium",
        run.status === "failed" && !run.blockedBy
          ? "text-destructive"
          : run.status === "success"
            ? "text-emerald-700 dark:text-emerald-400"
            : "text-muted-foreground",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      <span>{label}</span>
    </span>
  );
}

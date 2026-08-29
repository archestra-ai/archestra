import type { AgentExecution } from "@/lib/agent-background-execution.query";
import { cn } from "@/lib/utils";

export function AgentExecutionState({
  state,
  compact = false,
}: {
  state: AgentExecution["state"];
  compact?: boolean;
}) {
  const presentation = executionStatePresentation(state);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 font-medium text-muted-foreground",
        compact ? "text-[11px]" : "text-xs",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          presentation.pulse && "animate-pulse",
          presentation.dotClassName,
        )}
      />
      {presentation.label}
    </span>
  );
}

function executionStatePresentation(state: AgentExecution["state"]): {
  label: string;
  dotClassName: string;
  pulse?: boolean;
} {
  switch (state) {
    case "TASK_STATE_WORKING":
      return { label: "Running", dotClassName: "bg-emerald-500" };
    case "TASK_STATE_COMPLETED":
      return { label: "Completed", dotClassName: "bg-muted-foreground/50" };
    case "TASK_STATE_FAILED":
      return { label: "Failed", dotClassName: "bg-destructive" };
    case "TASK_STATE_CANCELED":
      return { label: "Canceled", dotClassName: "bg-muted-foreground/50" };
    case "TASK_STATE_REJECTED":
      return { label: "Rejected", dotClassName: "bg-destructive" };
    case "TASK_STATE_INPUT_REQUIRED":
      return { label: "Needs input", dotClassName: "bg-amber-500" };
    case "TASK_STATE_AUTH_REQUIRED":
      return { label: "Needs auth", dotClassName: "bg-amber-500" };
    case "TASK_STATE_SUBMITTED":
      return { label: "Starting", dotClassName: "bg-sky-500", pulse: true };
    default:
      return { label: "Pending", dotClassName: "bg-sky-500", pulse: true };
  }
}

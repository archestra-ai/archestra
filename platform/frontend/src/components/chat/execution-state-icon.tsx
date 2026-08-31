import { Loader2, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The background-execution mark: a terminal glyph colored by the session's
 * state (spinner while starting). The single source for every execution-row
 * affordance (sidebar rows, search palette) so the visual stays consistent.
 */
export function ExecutionStateIcon({
  state,
  className,
}: {
  state: string;
  className?: string;
}) {
  const visual = executionStateVisual(state);
  if (visual.spinning) {
    return (
      <Loader2
        aria-label={visual.label}
        className={cn(
          "shrink-0 animate-spin",
          visual.colorClassName,
          className,
        )}
      />
    );
  }
  return (
    <TerminalSquare
      aria-label={visual.label}
      className={cn("shrink-0", visual.colorClassName, className)}
    />
  );
}

function executionStateVisual(state: string): {
  label: string;
  colorClassName: string;
  spinning: boolean;
} {
  switch (state) {
    case "TASK_STATE_SUBMITTED":
      return {
        label: "Execution starting",
        colorClassName: "text-amber-500",
        spinning: true,
      };
    case "TASK_STATE_WORKING":
    case "TASK_STATE_INPUT_REQUIRED":
      return {
        label: "Execution running",
        colorClassName: "text-emerald-500",
        spinning: false,
      };
    case "TASK_STATE_FAILED":
    case "TASK_STATE_REJECTED":
      return {
        label: "Execution failed",
        colorClassName: "text-destructive",
        spinning: false,
      };
    default:
      return {
        label: "Execution finished",
        colorClassName: "text-muted-foreground",
        spinning: false,
      };
  }
}

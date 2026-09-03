import { Loader2, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The agent-runtime mark: a terminal glyph colored by the session's
 * state (spinner while starting). The single source for every run-row
 * affordance (sidebar rows, search palette) so the visual stays consistent.
 */
export function RunStateIcon({
  state,
  className,
}: {
  state: string;
  className?: string;
}) {
  const visual = runStateVisual(state);
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

function runStateVisual(state: string): {
  label: string;
  colorClassName: string;
  spinning: boolean;
} {
  switch (state) {
    case "TASK_STATE_SUBMITTED":
      return {
        label: "Run starting",
        colorClassName: "text-amber-500",
        spinning: true,
      };
    case "TASK_STATE_WORKING":
    case "TASK_STATE_INPUT_REQUIRED":
      return {
        label: "Run running",
        colorClassName: "text-emerald-500",
        spinning: false,
      };
    case "TASK_STATE_FAILED":
    case "TASK_STATE_REJECTED":
      return {
        label: "Run failed",
        colorClassName: "text-destructive",
        spinning: false,
      };
    default:
      return {
        label: "Run finished",
        colorClassName: "text-muted-foreground",
        spinning: false,
      };
  }
}

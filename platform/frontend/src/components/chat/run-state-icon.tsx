import { TerminalSquare } from "lucide-react";
import { hasNoRecentModelActivity } from "@/components/agent-run-liveness";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentRunSession } from "@/lib/agent-runtime.query";
import { cn } from "@/lib/utils";

/**
 * The single run-status mark for compact navigation surfaces. Explicit task
 * states take precedence, followed by deadline and model-activity signals.
 */
export function RunStateIcon({
  state,
  attentionState,
  startedAt,
  endedAt,
  hardDeadlineAt,
  lastModelActivityAt,
  className,
}: RunStateIconProps) {
  const visual = runStateVisual({
    state,
    attentionState,
    startedAt,
    endedAt,
    hardDeadlineAt,
    lastModelActivityAt,
  });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TerminalSquare
          aria-label={visual.label}
          className={cn(
            "shrink-0",
            visual.pulsing && "animate-pulse motion-reduce:animate-none",
            visual.colorClassName,
            className,
          )}
        />
      </TooltipTrigger>
      <TooltipContent sideOffset={5}>
        <span>{visual.label}</span>
      </TooltipContent>
    </Tooltip>
  );
}

interface RunStateIconProps {
  state: AgentRunSession["state"];
  attentionState?: AgentRunSession["attentionState"];
  startedAt?: AgentRunSession["startedAt"];
  endedAt?: AgentRunSession["endedAt"];
  hardDeadlineAt?: AgentRunSession["hardDeadlineAt"];
  lastModelActivityAt?: AgentRunSession["lastModelActivityAt"];
  className?: string;
}

function runStateVisual({
  state,
  attentionState,
  startedAt,
  endedAt,
  hardDeadlineAt,
  lastModelActivityAt,
}: Omit<RunStateIconProps, "className">): RunStateVisual {
  if (state === "TASK_STATE_FAILED" || state === "TASK_STATE_REJECTED") {
    return {
      label: "Run failed",
      colorClassName: "text-destructive",
      pulsing: false,
    };
  }
  if (state === "TASK_STATE_COMPLETED") {
    return {
      label: "Run completed",
      colorClassName: "text-muted-foreground",
      pulsing: false,
    };
  }
  if (state === "TASK_STATE_CANCELED") {
    return {
      label: "Run canceled",
      colorClassName: "text-muted-foreground",
      pulsing: false,
    };
  }
  if (
    attentionState === "input_required" ||
    state === "TASK_STATE_INPUT_REQUIRED"
  ) {
    return {
      label: "Run waiting for input",
      colorClassName: "text-amber-500",
      pulsing: false,
    };
  }
  if (
    attentionState === "auth_required" ||
    state === "TASK_STATE_AUTH_REQUIRED"
  ) {
    return {
      label: "Run authentication required",
      colorClassName: "text-amber-500",
      pulsing: false,
    };
  }
  if (
    endedAt === null &&
    hardDeadlineAt &&
    new Date(hardDeadlineAt).getTime() <= Date.now()
  ) {
    return {
      label: "Run cleanup pending",
      colorClassName: "text-amber-500",
      pulsing: false,
    };
  }
  if (
    startedAt &&
    endedAt === null &&
    hasNoRecentModelActivity({
      state,
      startedAt,
      endedAt,
      lastModelActivityAt: lastModelActivityAt ?? null,
    })
  ) {
    return {
      label: "Run may be stalled",
      colorClassName: "text-amber-500",
      pulsing: false,
    };
  }

  switch (state) {
    case "TASK_STATE_SUBMITTED":
      return {
        label: "Run starting",
        colorClassName: "text-amber-500",
        pulsing: true,
      };
    case "TASK_STATE_WORKING":
      return {
        label: "Run active",
        colorClassName: "text-emerald-500",
        pulsing: false,
      };
    default:
      return {
        label: "Run finished",
        colorClassName: "text-muted-foreground",
        pulsing: false,
      };
  }
}

interface RunStateVisual {
  label: string;
  colorClassName: string;
  pulsing: boolean;
}

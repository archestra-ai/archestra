import type { SVGProps } from "react";
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
        <RunTerminalIcon
          label={visual.label}
          indicator={visual.indicator}
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
      indicator: "failure",
      pulsing: false,
    };
  }
  if (state === "TASK_STATE_COMPLETED") {
    return {
      label: "Run completed",
      colorClassName: "text-muted-foreground",
      indicator: "check",
      pulsing: false,
    };
  }
  if (state === "TASK_STATE_CANCELED") {
    return {
      label: "Run canceled",
      colorClassName: "text-muted-foreground",
      indicator: "cancel",
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
      indicator: "question",
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
      indicator: "lock",
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
      indicator: "warning",
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
      indicator: "warning",
      pulsing: false,
    };
  }

  switch (state) {
    case "TASK_STATE_SUBMITTED":
      return {
        label: "Run starting",
        colorClassName: "text-amber-500",
        indicator: "pending",
        pulsing: true,
      };
    case "TASK_STATE_WORKING":
      return {
        label: "Run active",
        colorClassName: "text-emerald-500",
        indicator: "prompt",
        pulsing: false,
      };
    default:
      return {
        label: "Run finished",
        colorClassName: "text-muted-foreground",
        indicator: "prompt",
        pulsing: false,
      };
  }
}

type RunTerminalIndicator =
  | "cancel"
  | "check"
  | "failure"
  | "lock"
  | "pending"
  | "prompt"
  | "question"
  | "warning";

interface RunStateVisual {
  label: string;
  colorClassName: string;
  indicator: RunTerminalIndicator;
  pulsing: boolean;
}

function RunTerminalIcon({
  indicator,
  label,
  ...props
}: SVGProps<SVGSVGElement> & {
  indicator: RunTerminalIndicator;
  label: string;
}) {
  return (
    <svg
      aria-label={label}
      fill="none"
      role="img"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      {...props}
    >
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M3 8.5h18" opacity="0.65" />
      {indicator === "prompt" && (
        <>
          <path d="m7.5 11.25 2.25 2-2.25 2" />
          <path d="M12 15.25h4.5" />
        </>
      )}
      {indicator === "pending" && (
        <>
          <circle cx="9" cy="14" r="0.7" fill="currentColor" stroke="none" />
          <circle cx="12" cy="14" r="0.7" fill="currentColor" stroke="none" />
          <circle cx="15" cy="14" r="0.7" fill="currentColor" stroke="none" />
        </>
      )}
      {indicator === "warning" && (
        <>
          <path d="M12 11v3" />
          <path d="M12 16.5h.01" />
        </>
      )}
      {indicator === "question" && (
        <>
          <path d="M10.25 12a1.85 1.85 0 1 1 2.5 1.75c-.5.23-.75.58-.75 1" />
          <path d="M12 16.5h.01" />
        </>
      )}
      {indicator === "lock" && (
        <>
          <rect x="9" y="12.25" width="6" height="4.5" rx="1" />
          <path d="M10.5 12.25V11a1.5 1.5 0 0 1 3 0v1.25" />
        </>
      )}
      {indicator === "check" && <path d="m8.5 13.75 2.25 2 4.75-4.75" />}
      {indicator === "cancel" && <path d="M8.5 14h7" />}
      {indicator === "failure" && (
        <>
          <path d="m9.5 11.5 5 5" />
          <path d="m14.5 11.5-5 5" />
        </>
      )}
    </svg>
  );
}

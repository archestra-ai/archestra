import {
  AlertTriangle,
  CircleCheck,
  CircleStop,
  CircleX,
  KeyRound,
  Loader2,
  type LucideIcon,
  MessageCircleQuestion,
  TerminalSquare,
} from "lucide-react";
import { hasNoRecentModelActivity } from "@/components/agent-run-liveness";
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
  const Icon = visual.icon;
  return (
    <span title={visual.label} className="inline-flex shrink-0">
      <Icon
        aria-label={visual.label}
        className={cn(
          "shrink-0",
          visual.spinning && "animate-spin motion-reduce:animate-none",
          visual.colorClassName,
          className,
        )}
      />
    </span>
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
}: Omit<RunStateIconProps, "className">): {
  label: string;
  colorClassName: string;
  icon: LucideIcon;
  spinning: boolean;
} {
  if (state === "TASK_STATE_FAILED" || state === "TASK_STATE_REJECTED") {
    return {
      label: "Run failed",
      colorClassName: "text-destructive",
      icon: CircleX,
      spinning: false,
    };
  }
  if (state === "TASK_STATE_COMPLETED") {
    return {
      label: "Run completed",
      colorClassName: "text-muted-foreground",
      icon: CircleCheck,
      spinning: false,
    };
  }
  if (state === "TASK_STATE_CANCELED") {
    return {
      label: "Run canceled",
      colorClassName: "text-muted-foreground",
      icon: CircleStop,
      spinning: false,
    };
  }
  if (
    attentionState === "input_required" ||
    state === "TASK_STATE_INPUT_REQUIRED"
  ) {
    return {
      label: "Run waiting for input",
      colorClassName: "text-amber-500",
      icon: MessageCircleQuestion,
      spinning: false,
    };
  }
  if (
    attentionState === "auth_required" ||
    state === "TASK_STATE_AUTH_REQUIRED"
  ) {
    return {
      label: "Run authentication required",
      colorClassName: "text-amber-500",
      icon: KeyRound,
      spinning: false,
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
      icon: AlertTriangle,
      spinning: false,
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
      icon: AlertTriangle,
      spinning: false,
    };
  }

  switch (state) {
    case "TASK_STATE_SUBMITTED":
      return {
        label: "Run starting",
        colorClassName: "text-amber-500",
        icon: Loader2,
        spinning: true,
      };
    case "TASK_STATE_WORKING":
      return {
        label: "Run active",
        colorClassName: "text-emerald-500",
        icon: TerminalSquare,
        spinning: false,
      };
    default:
      return {
        label: "Run finished",
        colorClassName: "text-muted-foreground",
        icon: TerminalSquare,
        spinning: false,
      };
  }
}

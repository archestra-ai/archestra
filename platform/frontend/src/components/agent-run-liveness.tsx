"use client";

import { AlertTriangle, Clock3, MessageCircleQuestion } from "lucide-react";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { NO_MODEL_ACTIVITY_WARNING_MS } from "@/lib/agent-run-activity";
import type { AgentRun } from "@/lib/agent-runtime.query";
import {
  formatRuntimeDuration as formatDuration,
  useRuntimeClock as useCurrentTime,
} from "@/lib/agent-runtime-time";
import { cn } from "@/lib/utils/tailwind";

export function AgentRunLiveness({
  run,
  className,
}: {
  run: Pick<
    AgentRun,
    | "attentionState"
    | "endedAt"
    | "hardDeadlineAt"
    | "lastModelActivityAt"
    | "startedAt"
    | "state"
  >;
  className?: string;
}) {
  const now = useCurrentTime(run.endedAt === null);
  if (run.endedAt !== null) return null;

  const presentation = getLivenessPresentation(run, now);
  const Icon = presentation.icon;
  const deadline = new Date(run.hardDeadlineAt);

  return (
    <InlineNotice
      role="status"
      variant={presentation.needsAttention ? "warning" : "neutral"}
      className={cn("shrink-0", className)}
    >
      <Icon aria-hidden />
      <span className="font-medium">{presentation.title}</span>
      <InlineNoticeText className="hidden @3xl:inline">
        {presentation.detail}
      </InlineNoticeText>
      <span className="ml-auto tabular-nums">
        {Number.isNaN(deadline.getTime()) ? (
          <span>{presentation.deadlineLabel}</span>
        ) : (
          <time
            dateTime={deadline.toISOString()}
            title={`Hard deadline: ${deadline.toLocaleString()}`}
            className="shrink-0 tabular-nums"
          >
            {presentation.deadlineLabel}
          </time>
        )}
      </span>
    </InlineNotice>
  );
}

export function hasNoRecentModelActivity(
  run: Pick<
    AgentRun,
    "endedAt" | "lastModelActivityAt" | "startedAt" | "state"
  >,
  now = Date.now(),
): boolean {
  return (
    run.endedAt === null &&
    (run.state === "TASK_STATE_WORKING" ||
      run.state === "TASK_STATE_SUBMITTED") &&
    now - modelActivityBaseline(run).getTime() >= NO_MODEL_ACTIVITY_WARNING_MS
  );
}

function getLivenessPresentation(
  run: Pick<
    AgentRun,
    | "attentionState"
    | "endedAt"
    | "hardDeadlineAt"
    | "lastModelActivityAt"
    | "startedAt"
    | "state"
  >,
  now: number,
): {
  title: string;
  detail: string;
  deadlineLabel: string;
  icon: typeof Clock3;
  needsAttention: boolean;
} {
  const deadlineAt = new Date(run.hardDeadlineAt).getTime();
  if (deadlineAt <= now) {
    return {
      title: "Cleanup pending",
      detail: "The hard deadline has passed and the runtime is reconciling.",
      deadlineLabel: `Deadline passed ${formatDuration(now - deadlineAt)} ago`,
      icon: AlertTriangle,
      needsAttention: true,
    };
  }

  const deadlineLabel = Number.isNaN(deadlineAt)
    ? "Hard deadline unavailable"
    : `Hard stop in ${formatDuration(deadlineAt - now)}`;
  if (
    run.attentionState === "input_required" ||
    run.state === "TASK_STATE_INPUT_REQUIRED"
  ) {
    return {
      title: "Waiting for input",
      detail: "The agent reported that it needs a response to continue.",
      deadlineLabel,
      icon: MessageCircleQuestion,
      needsAttention: true,
    };
  }
  if (
    run.attentionState === "auth_required" ||
    run.state === "TASK_STATE_AUTH_REQUIRED"
  ) {
    return {
      title: "Authentication required",
      detail: "The agent reported that credentials are needed to continue.",
      deadlineLabel,
      icon: MessageCircleQuestion,
      needsAttention: true,
    };
  }

  const inactivityMs = now - modelActivityBaseline(run).getTime();
  if (hasNoRecentModelActivity(run, now)) {
    return {
      title: run.lastModelActivityAt
        ? `No model activity for ${formatDuration(inactivityMs)}`
        : `No model requests after ${formatDuration(inactivityMs)}`,
      detail: run.lastModelActivityAt
        ? "It may be running a long command or waiting at a terminal prompt."
        : "The runtime may be blocked before its first model request.",
      deadlineLabel,
      icon: AlertTriangle,
      needsAttention: true,
    };
  }

  return {
    title: run.lastModelActivityAt
      ? inactivityMs < 60_000
        ? "Model active now"
        : `Model active ${formatDuration(inactivityMs)} ago`
      : "Waiting for first model request",
    detail: run.lastModelActivityAt
      ? "The run is making recent model requests."
      : "The runtime is still starting.",
    deadlineLabel,
    icon: Clock3,
    needsAttention: false,
  };
}

export function modelActivityBaseline(
  run: Pick<AgentRun, "lastModelActivityAt" | "startedAt">,
): Date {
  return new Date(run.lastModelActivityAt ?? run.startedAt);
}

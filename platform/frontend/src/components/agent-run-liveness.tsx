"use client";

import { AlertTriangle, Clock3, MessageCircleQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentRun } from "@/lib/agent-runtime.query";
import { cn } from "@/lib/utils";

export function AgentRunLiveness({
  run,
  className,
}: {
  run: Pick<
    AgentRun,
    "endedAt" | "hardDeadlineAt" | "lastModelActivityAt" | "startedAt" | "state"
  >;
  className?: string;
}) {
  const now = useCurrentTime(run.endedAt === null);
  if (run.endedAt !== null) return null;

  const presentation = getLivenessPresentation(run, now);
  const Icon = presentation.icon;

  return (
    <output
      className={cn(
        "flex shrink-0 flex-col gap-2 rounded-md border px-3 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between",
        presentation.needsAttention
          ? "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100"
          : "bg-muted/20 text-muted-foreground",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2 sm:items-center">
        <Icon
          aria-hidden
          className={cn(
            "mt-0.5 size-3.5 shrink-0 sm:mt-0",
            presentation.needsAttention
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground",
          )}
        />
        <span className="font-medium text-foreground">
          {presentation.title}
        </span>
        <span className="hidden text-muted-foreground md:inline">
          {presentation.detail}
        </span>
      </div>
      <time
        dateTime={new Date(run.hardDeadlineAt).toISOString()}
        title={`Hard deadline: ${new Date(run.hardDeadlineAt).toLocaleString()}`}
        className="shrink-0 tabular-nums"
      >
        {presentation.deadlineLabel}
      </time>
    </output>
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
    "endedAt" | "hardDeadlineAt" | "lastModelActivityAt" | "startedAt" | "state"
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

  const deadlineLabel = `Hard stop in ${formatDuration(deadlineAt - now)}`;
  if (run.state === "TASK_STATE_INPUT_REQUIRED") {
    return {
      title: "Waiting for input",
      detail: "The agent reported that it needs a response to continue.",
      deadlineLabel,
      icon: MessageCircleQuestion,
      needsAttention: true,
    };
  }
  if (run.state === "TASK_STATE_AUTH_REQUIRED") {
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

function modelActivityBaseline(
  run: Pick<AgentRun, "lastModelActivityAt" | "startedAt">,
): Date {
  return new Date(run.lastModelActivityAt ?? run.startedAt);
}

function useCurrentTime(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(interval);
  }, [active]);

  return now;
}

function formatDuration(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

const NO_MODEL_ACTIVITY_WARNING_MS = 15 * 60_000;
const CLOCK_TICK_MS = 30_000;

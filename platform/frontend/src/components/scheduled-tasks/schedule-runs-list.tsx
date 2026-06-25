"use client";

import { AlertCircle, ExternalLink, Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  runChatHref,
  runRowKind,
} from "@/app/projects/[id]/schedules/[triggerId]/run-row.utils";
import {
  getScheduleTriggerRunSessionId,
  isScheduleTriggerRunActive,
} from "@/app/scheduled-tasks/schedule-trigger.utils";
import { StatusBadge } from "@/components/scheduled-tasks/status-badge";
import {
  type ScheduleTriggerRun,
  useScheduleTriggerRuns,
} from "@/lib/schedule-trigger.query";
import { cn } from "@/lib/utils";

/**
 * A schedule's runs, reused by the project runs page and the chat right-side
 * Runs panel. A completed run (succeeded OR failed) links to its chat — a failed
 * run's chat shows the error as an inline error card. A failed run that never
 * produced a conversation expands an inline error here instead; a running run is
 * inert. Polls while any run is active; `currentRunId` highlights the current run.
 */
export function ScheduleRunsList({
  triggerId,
  projectId,
  currentRunId,
  emptyText = "No runs yet.",
}: {
  triggerId: string;
  projectId: string;
  currentRunId?: string | null;
  emptyText?: string;
}) {
  const [hasActiveRun, setHasActiveRun] = useState(false);

  const { data: runsResponse, isLoading } = useScheduleTriggerRuns(triggerId, {
    limit: 50,
    refetchInterval: hasActiveRun ? 3_000 : false,
  });
  const runs = runsResponse?.data ?? [];

  const nextHasActiveRun = runs.some((r) =>
    isScheduleTriggerRunActive(r.status),
  );
  if (nextHasActiveRun !== hasActiveRun) {
    setHasActiveRun(nextHasActiveRun);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <p className="rounded-xl border px-4 py-8 text-center text-sm text-muted-foreground">
        {emptyText}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {runs.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          projectId={projectId}
          triggerId={triggerId}
          isCurrent={run.id === currentRunId}
        />
      ))}
    </div>
  );
}

// === internal ===

function RunRow({
  run,
  projectId,
  triggerId,
  isCurrent,
}: {
  run: ScheduleTriggerRun;
  projectId: string;
  triggerId: string;
  isCurrent: boolean;
}) {
  const kind = runRowKind(run);
  const [errorExpanded, setErrorExpanded] = useState(false);

  const rowContent = (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <StatusBadge label={run.status} />
      <span className="flex-1 truncate text-sm text-muted-foreground">
        {formatRunTimestamp(run.createdAt)}
      </span>
      {kind === "running" && (
        <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
      )}
    </div>
  );

  if (kind === "open-chat") {
    const href = runChatHref({ projectId, triggerId, run });
    if (!href) {
      return <div className="rounded-lg border bg-card">{rowContent}</div>;
    }
    return (
      <Link
        href={href}
        className={cn(
          "block rounded-lg border bg-card transition-colors hover:bg-accent",
          isCurrent && "border-primary bg-accent",
        )}
      >
        {rowContent}
      </Link>
    );
  }

  if (kind === "show-error") {
    return (
      <div
        className={cn(
          "rounded-lg border bg-card",
          isCurrent && "border-primary bg-accent",
        )}
      >
        <button
          type="button"
          className="w-full rounded-lg text-left transition-colors hover:bg-accent"
          onClick={() => setErrorExpanded((v) => !v)}
        >
          {rowContent}
        </button>
        {errorExpanded && <RunErrorCard runId={run.id} error={run.error} />}
      </div>
    );
  }

  // "running" — inert
  return (
    <div className="rounded-lg border bg-card opacity-80">{rowContent}</div>
  );
}

function RunErrorCard({
  runId,
  error,
}: {
  runId: string;
  error: string | null;
}) {
  const sessionId = getScheduleTriggerRunSessionId(runId);
  const logsHref = `/llm/logs/session/${encodeURIComponent(sessionId)}`;

  return (
    <div className="mx-3 mb-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-destructive">
        <AlertCircle className="h-3.5 w-3.5" />
        Error
      </div>
      <p className="mb-2 whitespace-pre-wrap text-sm text-foreground">
        {error ?? "The run failed without an error message."}
      </p>
      <a
        href={logsHref}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        View session logs
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

function formatRunTimestamp(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) {
    return `Today at ${timeStr}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  if (isYesterday) {
    return `Yesterday at ${timeStr}`;
  }

  const dateStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return `${dateStr} at ${timeStr}`;
}

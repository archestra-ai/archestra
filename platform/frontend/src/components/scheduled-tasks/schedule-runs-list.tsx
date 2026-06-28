"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  runChatHref,
  runRowKind,
} from "@/app/projects/[id]/schedules/[triggerId]/run-row.utils";
import { isScheduleTriggerRunActive } from "@/app/scheduled-tasks/schedule-trigger.utils";
import { StatusBadge } from "@/components/scheduled-tasks/status-badge";
import { useResolveRunChat } from "@/components/scheduled-tasks/use-resolve-run-chat";
import {
  type ScheduleTriggerRun,
  useScheduleTriggerRuns,
} from "@/lib/schedule-trigger.query";
import { cn } from "@/lib/utils";
import { formatRunTimestamp } from "@/lib/utils/format-run-timestamp";

/**
 * A schedule's runs, reused by the project runs page and the chat right-side
 * Runs panel. Every run opens a chat: a run with a conversation links straight to
 * it (a failed run's chat shows the prompt + an inline error card with "Try
 * again"); a completed run without one (legacy) lazily creates it on click; a
 * still-running run is inert. Polls while any run is active; `currentRunId`
 * highlights the current run.
 */
export function ScheduleRunsList({
  triggerId,
  currentRunId,
  emptyText = "No runs yet.",
}: {
  triggerId: string;
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
  triggerId,
  isCurrent,
}: {
  run: ScheduleTriggerRun;
  triggerId: string;
  isCurrent: boolean;
}) {
  const kind = runRowKind(run);
  const { resolve, isResolving } = useResolveRunChat();

  const rowContent = (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <StatusBadge label={run.status} />
      <span className="flex-1 truncate text-sm text-muted-foreground">
        {formatRunTimestamp(run.createdAt)}
      </span>
      {(kind === "running" || isResolving) && (
        <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
      )}
    </div>
  );

  if (kind === "open-chat") {
    const href = runChatHref({ triggerId, run });
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

  if (kind === "resolve") {
    // Legacy run without a conversation: create one on click, then open it.
    return (
      <button
        type="button"
        disabled={isResolving}
        className={cn(
          "block w-full rounded-lg border bg-card text-left transition-colors hover:bg-accent",
          isCurrent && "border-primary bg-accent",
        )}
        onClick={() => resolve(triggerId, run.id)}
      >
        {rowContent}
      </button>
    );
  }

  // "running" — inert
  return (
    <div className="rounded-lg border bg-card opacity-80">{rowContent}</div>
  );
}

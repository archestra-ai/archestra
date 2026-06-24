"use client";

import {
  AlertCircle,
  ArrowLeft,
  ExternalLink,
  Loader2,
  Play,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  getScheduleTriggerRunSessionId,
  isScheduleTriggerRunActive,
} from "@/app/scheduled-tasks/schedule-trigger.utils";
import { StatusBadge } from "@/components/scheduled-tasks/status-badge";
import { Button } from "@/components/ui/button";
import { useProject } from "@/lib/projects/projects.query";
import {
  type ScheduleTriggerRun,
  useRunScheduleTriggerNow,
  useScheduleTrigger,
  useScheduleTriggerRuns,
} from "@/lib/schedule-trigger.query";
import { formatCronSchedule } from "@/lib/utils/format-cron";
import { runChatHref, runRowKind } from "./run-row.utils";

// === public component ===

export function ProjectScheduleRunsClient() {
  const { id: projectId, triggerId } = useParams<{
    id: string;
    triggerId: string;
  }>();

  const [hasActiveRun, setHasActiveRun] = useState(false);

  const { data: project } = useProject(projectId);
  const { data: trigger, isLoading: triggerLoading } =
    useScheduleTrigger(triggerId);
  const runNowMutation = useRunScheduleTriggerNow();

  const { data: runsResponse, isLoading: runsLoading } = useScheduleTriggerRuns(
    triggerId,
    {
      limit: 50,
      refetchInterval: hasActiveRun ? 3_000 : false,
    },
  );

  const runs = runsResponse?.data ?? [];

  // Keep polling state in sync with fetched data.
  const nextHasActiveRun = runs.some((r) =>
    isScheduleTriggerRunActive(r.status),
  );
  if (nextHasActiveRun !== hasActiveRun) {
    setHasActiveRun(nextHasActiveRun);
  }

  const displayRuns = runs;

  const projectName = project?.name ?? "Project";
  const triggerName = trigger?.name ?? "Schedule";

  const onRunNow = () => {
    runNowMutation.mutate(triggerId);
  };

  if (triggerLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {/* Back link */}
      <Link
        href={`/projects/${projectId}`}
        className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {projectName}
      </Link>

      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{triggerName} — Runs</h1>
          {trigger && (
            <p className="mt-1 text-sm text-muted-foreground">
              {trigger.agent?.name ?? "Default agent"} ·{" "}
              {formatCronSchedule(trigger.cronExpression)} · {trigger.timezone}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRunNow}
          disabled={runNowMutation.isPending}
        >
          {runNowMutation.isPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="mr-1.5 h-3.5 w-3.5" />
          )}
          Run now
        </Button>
      </div>

      {/* Runs list */}
      {runsLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : displayRuns.length === 0 ? (
        <p className="rounded-xl border px-4 py-8 text-center text-sm text-muted-foreground">
          No runs yet.
        </p>
      ) : (
        <div className="space-y-1">
          {displayRuns.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              projectId={projectId}
              triggerId={triggerId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// === internal components ===

function RunRow({
  run,
  projectId,
  triggerId,
}: {
  run: ScheduleTriggerRun;
  projectId: string;
  triggerId: string;
}) {
  const kind = runRowKind(run);
  const [errorExpanded, setErrorExpanded] = useState(false);

  const rowContent = (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <StatusBadge label={run.status} />
      <span className="flex-1 truncate text-sm text-muted-foreground">
        {formatRunTimestamp(run.createdAt)}
      </span>
      {run.artifact && (
        <span className="max-w-xs truncate text-sm text-foreground">
          {firstLine(run.artifact)}
        </span>
      )}
      {kind === "running" && (
        <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
      )}
    </div>
  );

  if (kind === "open-chat") {
    const href = runChatHref({ projectId, triggerId, run });
    if (!href) {
      // Should not happen when kind === "open-chat", but guard for type safety.
      return <div className="rounded-lg border bg-card">{rowContent}</div>;
    }
    return (
      <Link
        href={href}
        className="block rounded-lg border bg-card transition-colors hover:bg-accent"
      >
        {rowContent}
      </Link>
    );
  }

  if (kind === "show-error") {
    return (
      <div className="rounded-lg border bg-card">
        <button
          type="button"
          className="w-full text-left transition-colors hover:bg-accent rounded-lg"
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

// === helpers ===

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

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

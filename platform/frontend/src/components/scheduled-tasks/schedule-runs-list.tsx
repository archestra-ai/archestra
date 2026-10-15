"use client";

import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleDashed,
  CornerUpLeft,
  Loader2,
  Minus,
  Square,
  X,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  runHref,
  runRowKind,
} from "@/app/projects/[id]/schedules/[triggerId]/run-row.utils";
import { ScheduleRunBlockedDetails } from "@/components/scheduled-tasks/schedule-run-blocked-details";
import {
  scheduleRunDuration,
  scheduleRunEventTime,
  scheduleRunOutcome,
  scheduleRunTime,
} from "@/components/scheduled-tasks/schedule-run-timeline.utils";
import { isScheduleTriggerRunActive } from "@/components/scheduled-tasks/schedule-trigger.utils";
import { useResolveRunChat } from "@/components/scheduled-tasks/use-resolve-run-chat";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  type ScheduleTriggerRun,
  useScheduleTriggerRuns,
} from "@/lib/schedule-trigger.query";
import { cn } from "@/lib/utils/tailwind";

/** Run history shared by project pages and the narrow chat Runs panel. */
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
  const [expandedId, setExpandedId] = useState<string | null | undefined>(
    undefined,
  );
  const { data: runsResponse, isLoading } = useScheduleTriggerRuns(triggerId, {
    limit: 50,
    refetchInterval: hasActiveRun ? 3000 : 5000,
  });
  const runs = runsResponse?.data ?? [];
  const active = runs.some((run) => isScheduleTriggerRunActive(run.status));
  if (active !== hasActiveRun) setHasActiveRun(active);
  if (isLoading)
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  if (!runs.length)
    return (
      <p className="rounded-xl border px-4 py-8 text-center text-sm text-muted-foreground">
        {emptyText}
      </p>
    );
  const ordered = [...runs].sort(
    (a, b) =>
      new Date(scheduleRunEventTime(b)).getTime() -
      new Date(scheduleRunEventTime(a)).getTime(),
  );
  const selectedId =
    expandedId === undefined
      ? (currentRunId ?? runs.find((run) => run.blockedBy)?.id)
      : expandedId;
  return (
    <section className="@container min-w-0" aria-label="Run activity">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Run activity</h2>
        <span className="text-xs text-muted-foreground">Newest first</span>
      </div>
      <ol>
        {ordered.map((run, index) => {
          const timestamp = scheduleRunEventTime(run);
          const day = new Date(timestamp).toLocaleDateString([], {
            month: "short",
            day: "numeric",
            year: "numeric",
          });
          const previousDay = index
            ? new Date(
                scheduleRunEventTime(ordered[index - 1]),
              ).toLocaleDateString([], {
                month: "short",
                day: "numeric",
                year: "numeric",
              })
            : null;
          return (
            <li key={run.id}>
              {day !== previousDay && (
                <p className="mb-2 mt-4 pl-8 text-xs text-muted-foreground @lg:pl-[7.25rem]">
                  {day}
                </p>
              )}
              <RunEvent
                run={run}
                triggerId={triggerId}
                timestamp={timestamp}
                isLast={index === ordered.length - 1}
                isCurrent={run.id === currentRunId}
                expanded={selectedId === run.id}
                onToggle={() =>
                  setExpandedId(selectedId === run.id ? null : run.id)
                }
                blockingRun={runs.find(
                  (candidate) => candidate.id === run.blockedBy?.runId,
                )}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function RunEvent({
  run,
  triggerId,
  timestamp,
  isLast,
  isCurrent,
  expanded,
  onToggle,
  blockingRun,
}: {
  run: ScheduleTriggerRun;
  triggerId: string;
  timestamp: string;
  isLast: boolean;
  isCurrent: boolean;
  expanded: boolean;
  onToggle: () => void;
  blockingRun?: ScheduleTriggerRun;
}) {
  const skipped = !!run.blockedBy;
  const queued =
    run.status === "running" && !run.runtimeTaskId && !run.chatConversationId;
  const Icon = skipped
    ? Minus
    : run.status === "running"
      ? CircleDashed
      : run.status === "cancelled"
        ? Square
        : run.status === "success"
          ? Check
          : X;
  const kind = runRowKind(run);
  const href = runHref({ run, triggerId });
  const { resolve, isResolving } = useResolveRunChat();
  const blocker = run.blockedBy;
  const summary =
    blocker?.phase === "starting"
      ? `Previous run was starting · ${scheduleRunDuration(blocker.elapsedSeconds)} elapsed`
      : blocker?.phase === "stopping"
        ? `Previous run was stopping · ${scheduleRunDuration(blocker.elapsedSeconds)} elapsed`
        : blocker
          ? `Previous run was active for ${scheduleRunDuration(blocker.elapsedSeconds)}`
          : null;
  const time = (
    <time dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>
      {scheduleRunTime(timestamp)}
    </time>
  );
  const detailsId = `schedule-run-${run.id}`;
  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 @lg:grid-cols-[4.75rem_1.25rem_minmax(0,1fr)] @lg:gap-x-3">
      <div className="hidden pt-3 text-xs tabular-nums text-muted-foreground @lg:block">
        {time}
      </div>
      <div className="relative col-start-1 row-start-1 @lg:col-start-2">
        {!isLast && (
          <span
            aria-hidden
            className="absolute bottom-0 left-[9px] top-8 w-px bg-border"
          />
        )}
        <span
          aria-hidden
          className={cn(
            "relative z-10 mt-3 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground",
            run.status === "running" &&
              !skipped &&
              "border-amber-500/40 text-amber-500",
          )}
        >
          <Icon className="size-3" strokeWidth={1.5} />
        </span>
      </div>
      <div
        className={cn(
          "col-start-2 mb-2 min-w-0 rounded-md px-2 @lg:col-start-3 @lg:px-3",
          expanded && "bg-muted/35",
          isCurrent && "ring-1 ring-inset ring-primary/40",
        )}
      >
        <UnstyledButton
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-current={isCurrent ? "true" : undefined}
          className="flex min-h-11 w-full items-start gap-2 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="min-w-0 flex-1">
            <span className="mb-1 block text-xs tabular-nums text-muted-foreground @lg:hidden">
              {time}
            </span>
            <div className="flex items-baseline gap-3">
              <span className="text-sm font-medium">
                {scheduleRunOutcome(run)}
              </span>
              <span
                className="hidden shrink-0 font-mono text-[11px] text-muted-foreground @lg:inline"
                title={run.id}
              >
                {run.id.slice(0, 8)}
              </span>
            </div>
            {summary && (
              <div className="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                <CornerUpLeft className="mt-0.5 size-3 shrink-0" />
                <span>{summary}</span>
              </div>
            )}
          </div>
          <ChevronDown
            className={cn(
              "mt-1 size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
          />
        </UnstyledButton>
        {expanded && (
          <div id={detailsId} className="border-t pb-3 pt-3">
            {blocker ? (
              <ScheduleRunBlockedDetails
                run={run}
                triggerId={triggerId}
                blockingRun={blockingRun}
              />
            ) : (
              <div className="space-y-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {queued
                    ? "Waiting for execution to start."
                    : run.completedAt
                      ? `Finished ${new Date(run.completedAt).toLocaleString()}`
                      : "Open the run to inspect its progress or stop it."}
                </p>
                {run.error && (
                  <InlineNotice variant="error">
                    <X />
                    <InlineNoticeText>{run.error}</InlineNoticeText>
                  </InlineNotice>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {href && (
                    <Button asChild variant="outline" size="xs">
                      <Link href={href}>
                        <span>Open run</span>
                        <ArrowUpRight className="size-3" />
                      </Link>
                    </Button>
                  )}
                  {kind === "resolve" && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => resolve(triggerId, run.id)}
                      disabled={isResolving}
                    >
                      {isResolving && (
                        <Loader2 className="size-3 animate-spin" />
                      )}
                      <span>Open run</span>
                    </Button>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {run.runKind === "manual"
                      ? "Started manually"
                      : "Scheduled"}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

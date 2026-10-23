"use client";

import { Bot, ChevronDown, ChevronRight, FileText } from "lucide-react";
import Link from "next/link";
import type { ReactNode, UIEventHandler } from "react";
import { useEffect, useRef, useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type {
  ScheduleTrigger,
  ScheduleTriggerRun,
} from "@/lib/schedule-trigger.query";
import { formatCronSchedule } from "@/lib/utils/format-cron";
import { cn } from "@/lib/utils/tailwind";
import {
  nextScheduleTime as nextTime,
  scheduleDateTime,
  scheduleTimezone,
} from "./schedule-display.utils";
import { ScheduleRunDetails as RunDetail } from "./schedule-run-details";
import {
  scheduleRunLabel as outcome,
  ScheduleRunStatus as Status,
} from "./schedule-run-status";

export type HistoryFilter = "all" | "failed" | "manual";
type HistoryProps = {
  schedule: ScheduleTrigger;
  runs: ScheduleTriggerRun[];
  filter: HistoryFilter;
  onFilterChange: (filter: HistoryFilter) => void;
  onRetry: () => void;
  error?: unknown;
  loadingMore: boolean;
  hasNextPage: boolean;
  totalRuns: number;
  onLoadMore: () => void;
  isLoading: boolean;
  isError: boolean;
  moreError: boolean;
  currentRunId?: string | null;
  lastRunAt?: string | null;
  actions?: ReactNode;
  onScroll?: UIEventHandler<HTMLElement>;
};

export function ScheduleExecutionHistory({
  schedule,
  runs,
  isError,
  moreError,
  error,
  filter,
  onFilterChange,
  currentRunId,
  actions,
  lastRunAt,
  onScroll,
  onRetry,
  loadingMore = false,
  hasNextPage = false,
  totalRuns,
  onLoadMore,
  isLoading = false,
}: HistoryProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const loadRequested = useRef(false);
  const scrollRegion = useRef<HTMLElement>(null);
  const yearFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timezone,
    year: "numeric",
  });
  const currentYear = yearFormat.format(new Date());
  const byYear = new Map<string, ScheduleTriggerRun[]>();
  for (const run of runs) {
    const year = yearFormat.format(new Date(run.startedAt ?? run.createdAt));
    const group = byYear.get(year) ?? [];
    group.push(run);
    byYear.set(year, group);
  }
  const visibleRuns = runs;
  const timezone = scheduleTimezone(schedule.timezone);
  const agentName = schedule.agent?.name ?? "Default agent";
  const cadence = formatCronSchedule(schedule.cronExpression);
  const dayFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timezone,
    month: "short",
    day: "numeric",
  });
  const timeFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timezone,
    hour: "numeric",
    minute: "2-digit",
  });
  const lastExecution = lastRunAt
    ? scheduleDateTime(lastRunAt, schedule.timezone)
    : "Never run";
  const loadedLabel =
    totalRuns === undefined
      ? `${runs.length} loaded`
      : `${runs.length} of ${totalRuns} loaded`;

  useEffect(() => {
    if (!loadingMore) loadRequested.current = false;
  }, [loadingMore]);

  const requestMore = () => {
    if (
      !hasNextPage ||
      loadingMore ||
      isLoading ||
      loadRequested.current ||
      isError
    )
      return;
    loadRequested.current = true;
    onLoadMore();
  };

  return (
    <section className="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 space-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2
            className="min-w-0 flex-1 truncate text-sm font-semibold"
            title={schedule.name}
          >
            {schedule.name}
          </h2>
          {actions}
          <Badge variant="outline" className="shrink-0">
            {schedule.enabled ? "Active" : "Paused"}
          </Badge>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={showPrompt ? "Hide task prompt" : "Show task prompt"}
            title="Task prompt"
            aria-expanded={showPrompt}
            aria-controls="schedule-task-prompt"
            onClick={() => setShowPrompt(!showPrompt)}
          >
            <FileText className="size-3.5" />
          </Button>
        </div>
        <div className="grid min-w-0 grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] items-center gap-3 text-xs text-muted-foreground">
          <Link
            prefetch={false}
            href={`/agents/${schedule.agentId}`}
            className="inline-flex min-w-0 items-center gap-1 hover:underline"
            title={agentName}
          >
            <Bot className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{agentName}</span>
          </Link>
          <div
            className="flex min-w-0 items-center justify-end gap-1"
            title={`${cadence} · ${schedule.timezone}`}
          >
            <span className="truncate">{cadence}</span>
            <span className="shrink-0">· {timezone}</span>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-3 border-y py-2 text-xs">
          <div className="min-w-0">
            <dt className="text-muted-foreground">Next</dt>
            <dd
              className="mt-0.5 truncate font-medium tabular-nums"
              title={`${nextTime(schedule)} · ${schedule.timezone}`}
            >
              {nextTime(schedule)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">Last execution</dt>
            <dd
              className="mt-0.5 truncate font-medium tabular-nums"
              title={`${lastExecution} · ${schedule.timezone}`}
            >
              {lastExecution}
            </dd>
          </div>
        </dl>
        {showPrompt && (
          <p
            id="schedule-task-prompt"
            className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 text-xs leading-relaxed"
          >
            {schedule.messageTemplate}
          </p>
        )}
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <div className="mb-2 flex shrink-0 items-center justify-between gap-1">
          <h3 className="min-w-0 truncate text-sm font-medium">
            Execution history
          </h3>
          <fieldset
            className="inline-flex shrink-0 items-center gap-0.5 border-0 p-0"
            aria-label="Filter execution history"
          >
            {(
              [
                ["all", "All"],
                ["failed", "Failed"],
                ["manual", "Manual"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                size="xs"
                variant={filter === value ? "secondary" : "ghost"}
                aria-pressed={filter === value}
                onClick={() => {
                  onFilterChange(value);
                  setExpandedId(null);
                  scrollRegion.current?.scrollTo({ top: 0 });
                }}
              >
                <span>{label}</span>
              </Button>
            ))}
          </fieldset>
        </div>

        <section
          ref={scrollRegion}
          aria-label={`Execution history, newest first, ${timezone}`}
          aria-busy={isLoading || loadingMore}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded scroll region supports keyboard scrolling.
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onScroll={(event) => {
            onScroll?.(event);
            const region = event.currentTarget;
            if (
              region.scrollHeight - region.scrollTop - region.clientHeight <
              96
            )
              requestMore();
          }}
        >
          {isLoading ? (
            <output className="space-y-1" aria-label="Loading run history">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </output>
          ) : isError ? (
            <QueryLoadError
              title="Couldn’t load run history"
              error={error}
              onRetry={onRetry}
              className="py-8"
            />
          ) : visibleRuns.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm font-medium">
                {filter === "all" ? "No runs yet" : "No matching executions"}
              </p>
              {filter === "all" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  The first execution will appear here.
                </p>
              )}
              {filter !== "all" && (
                <Button
                  size="xs"
                  variant="link"
                  onClick={() => onFilterChange("all")}
                >
                  <span>Show all runs</span>
                </Button>
              )}
            </div>
          ) : (
            <ol className="relative before:absolute before:bottom-5 before:left-[5px] before:top-5 before:w-px before:bg-border">
              {[...byYear.entries()].map(([year, yearRuns]) => (
                <li key={year} className="relative">
                  {year !== currentYear && (
                    <h4 className="sticky top-0 z-10 flex items-center gap-2 bg-background py-1.5 text-[10px] font-medium tracking-wide text-muted-foreground">
                      <span>{year}</span>
                      <span aria-hidden className="h-px flex-1 bg-border" />
                    </h4>
                  )}
                  <ol>
                    {yearRuns.map((run) => {
                      const expanded = expandedId === run.id;
                      const Chevron = expanded ? ChevronDown : ChevronRight;
                      const timestamp = new Date(
                        run.startedAt ?? run.createdAt,
                      );
                      const date = dayFormat.format(timestamp);
                      const time = timeFormat.format(timestamp);
                      const rowTimezone = scheduleTimezone(
                        schedule.timezone,
                        timestamp,
                      );
                      return (
                        <li key={run.id} className="relative">
                          <UnstyledButton
                            className={cn(
                              "relative grid min-h-10 w-full grid-cols-[12px_48px_64px_minmax(0,1fr)_12px] items-center gap-x-1.5 rounded-md px-0 text-left text-xs outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring @2xl:grid-cols-[12px_52px_70px_104px_64px_76px_minmax(0,1fr)_12px]",
                              expanded && "bg-muted/40",
                              run.id === currentRunId &&
                                "ring-1 ring-inset ring-primary/40",
                            )}
                            aria-current={
                              run.id === currentRunId ? "true" : undefined
                            }
                            aria-expanded={expanded}
                            aria-controls={`schedule-execution-${run.id}`}
                            aria-label={`${date}, ${year}, ${time} ${rowTimezone}, ${outcome(run)}. ${expanded ? "Hide" : "Show"} run details`}
                            onClick={() =>
                              setExpandedId(expanded ? null : run.id)
                            }
                          >
                            <span
                              className="relative flex items-center justify-center bg-background py-1.5"
                              aria-hidden="true"
                            >
                              <span
                                className={cn(
                                  "size-1.5 rounded-full bg-muted-foreground/50",
                                  expanded && "bg-foreground",
                                )}
                              />
                            </span>
                            <span className="whitespace-nowrap font-medium tabular-nums">
                              {date}
                            </span>
                            <span className="whitespace-nowrap text-muted-foreground tabular-nums">
                              {time}
                            </span>
                            <Status run={run} />
                            <span className="hidden text-muted-foreground tabular-nums @2xl:block">
                              {run.startedAt && run.completedAt
                                ? `${Math.round((Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000)}s`
                                : "—"}
                            </span>
                            <span className="hidden text-muted-foreground @2xl:block">
                              {run.runKind === "manual"
                                ? "Manual"
                                : "Scheduled"}
                            </span>
                            <span
                              className="hidden truncate text-muted-foreground @2xl:block"
                              title={run.error ?? run.id}
                            >
                              {run.error ?? run.id.slice(0, 8)}
                            </span>
                            <Chevron
                              className="size-3.5 text-muted-foreground"
                              aria-hidden="true"
                            />
                          </UnstyledButton>
                          {expanded && (
                            <div
                              id={`schedule-execution-${run.id}`}
                              className="mb-2 ml-5 mt-1"
                            >
                              <RunDetail
                                run={run}
                                timezone={schedule.timezone}
                              />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </li>
              ))}
            </ol>
          )}
        </section>

        {!isError && !isLoading && (
          <div className="mt-2 flex shrink-0 items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
            <span
              className="min-w-0 truncate"
              aria-live="polite"
              title="Only loaded pages are kept in this list."
            >
              {loadedLabel}
            </span>
            {hasNextPage && (
              <Button
                size="xs"
                variant="ghost"
                disabled={loadingMore}
                onClick={requestMore}
              >
                <span>
                  {loadingMore
                    ? "Loading…"
                    : moreError
                      ? "Retry loading"
                      : "More"}
                </span>
                {!loadingMore && (
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                )}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

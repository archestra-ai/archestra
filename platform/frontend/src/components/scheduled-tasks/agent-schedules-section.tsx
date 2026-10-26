"use client";

import { ArrowUpRight, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { runHref } from "@/app/projects/[id]/schedules/[triggerId]/run-row.utils";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useProject } from "@/lib/projects/projects.query";
import {
  type ScheduleTrigger,
  useAgentSchedules,
  useScheduleTriggerRuns,
} from "@/lib/schedule-trigger.query";
import { formatCronSchedule } from "@/lib/utils/format-cron";
import { AgentScheduleCreateDialog } from "./agent-schedule-create-dialog";
import {
  nextScheduleDate,
  nextScheduleTime,
  scheduleDateTime,
} from "./schedule-display.utils";
import { ScheduleLink, scheduleHistoryHref } from "./schedule-link";
import { scheduleRunLabel } from "./schedule-run-status";

export function AgentSchedulesSection({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) {
  const { data: canRead } = useHasPermissions({ project: ["read"] });
  const { data: canCreate } = useHasPermissions({ project: ["create"] });
  const schedules = useAgentSchedules(canRead ? agentId : null);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const ordered = (
    schedules.data?.pages.flatMap((page) => page.data) ?? []
  ).sort(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) ||
      (nextScheduleDate(a)?.getTime() ?? Infinity) -
        (nextScheduleDate(b)?.getTime() ?? Infinity) ||
      a.name.localeCompare(b.name),
  );
  const visible = expanded ? ordered : ordered.slice(0, 2);
  const total = schedules.data?.pages[0]?.pagination.total;
  if (!canRead) return null;
  return (
    <section
      id="agent-schedules"
      className="@container overflow-hidden rounded-xl border bg-card"
      aria-label="Scheduled runs"
    >
      <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-5 py-3">
        <h2 className="text-sm font-semibold">
          Scheduled runs{" "}
          {total !== undefined && (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {total}
            </span>
          )}
        </h2>
        {canCreate && ordered.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            <span>Create schedule</span>
          </Button>
        )}
      </div>
      <div className="px-5 py-3">
        {schedules.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : schedules.isLoadingError ? (
          <QueryLoadError
            title="Couldn’t load schedules"
            error={schedules.error}
            onRetry={() => void schedules.refetch()}
            className="py-6"
          />
        ) : !ordered.length ? (
          <div className="space-y-2 py-4 text-center">
            <p className="text-sm font-medium">No scheduled runs yet</p>
            <p className="text-xs text-muted-foreground">
              Create a schedule to run this agent automatically.
            </p>
            {canCreate && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCreating(true)}
              >
                <Plus className="size-3.5" />
                Create schedule
              </Button>
            )}
          </div>
        ) : (
          <>
            <ul className="divide-y">
              {visible.map((schedule) => (
                <AgentScheduleRow key={schedule.id} schedule={schedule} />
              ))}
            </ul>
            {ordered.length > 2 && (
              <div className="mt-2 flex justify-end">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setExpanded(!expanded)}
                >
                  {expanded
                    ? "Show fewer"
                    : `View all ${total ?? ordered.length}`}
                </Button>
              </div>
            )}
            {expanded && schedules.hasNextPage && (
              <Button
                size="xs"
                variant="ghost"
                disabled={schedules.isFetchingNextPage}
                onClick={() => void schedules.fetchNextPage()}
              >
                {schedules.isFetchingNextPage
                  ? "Loading…"
                  : schedules.isFetchNextPageError
                    ? "Retry loading schedules"
                    : "More schedules"}
              </Button>
            )}
          </>
        )}
      </div>
      <AgentScheduleCreateDialog
        key={`${agentId}:${creating}`}
        agentId={agentId}
        agentName={agentName}
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          setExpanded(true);
          void schedules.refetch();
        }}
      />
    </section>
  );
}

function AgentScheduleRow({ schedule }: { schedule: ScheduleTrigger }) {
  const project = useProject(schedule.projectId ?? undefined);
  return (
    <li className="grid min-w-0 grid-cols-[104px_minmax(0,1fr)] items-start gap-x-3 py-2 first:pt-0 last:pb-0 @md:grid-cols-[136px_minmax(0,1fr)]">
      <div className="text-sm font-medium leading-5 tabular-nums">
        <time
          dateTime={nextScheduleDate(schedule)?.toISOString()}
          title={schedule.timezone}
        >
          {nextScheduleTime(schedule)}
        </time>
      </div>
      <div className="min-w-0">
        <ScheduleLink
          schedule={schedule}
          className="inline-flex max-w-full items-center gap-1 text-sm font-medium leading-5 hover:underline"
        >
          <span className="truncate">{schedule.name}</span>
          <ArrowUpRight
            className="size-3 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </ScheduleLink>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-4 text-muted-foreground">
          {schedule.projectId ? (
            <Link
              href={`/projects/${schedule.projectId}`}
              className="hover:underline"
            >
              {project.data?.name ?? "Project"}
            </Link>
          ) : (
            <span>Without a project</span>
          )}
          <span aria-hidden>·</span>
          <span title={schedule.timezone}>
            {formatCronSchedule(schedule.cronExpression)}
          </span>
          {!schedule.enabled && (
            <>
              <span aria-hidden>·</span>
              <span>Paused</span>
            </>
          )}
          <span aria-hidden>·</span>
          <LatestScheduleExecution schedule={schedule} />
        </div>
      </div>
    </li>
  );
}

function LatestScheduleExecution({ schedule }: { schedule: ScheduleTrigger }) {
  const latest = useScheduleTriggerRuns(schedule.id, { limit: 1 });
  const run = latest.data?.data[0];
  if (latest.isPending || latest.isError || !run)
    return (
      <span>
        {latest.isPending
          ? "Loading…"
          : latest.isError
            ? "Latest run unavailable"
            : "Never run"}
      </span>
    );
  const label = scheduleRunLabel(run);
  const failed = label === "Failed";
  const context = `Last execution: ${label} · ${scheduleDateTime(run.startedAt ?? run.createdAt, schedule.timezone)} · ${schedule.timezone}`;
  return (
    <Link
      prefetch={false}
      href={
        runHref({ triggerId: schedule.id, run }) ??
        scheduleHistoryHref(schedule)
      }
      title={context}
      aria-label={`${failed ? "Review failure" : "View last run"} for ${schedule.name}. ${context}`}
      className={
        failed
          ? "inline-flex items-center gap-1 rounded-sm text-xs text-destructive outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          : "inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      }
    >
      <span>{failed ? "Review failure" : "View last run"}</span>
      <span aria-hidden>→</span>
    </Link>
  );
}

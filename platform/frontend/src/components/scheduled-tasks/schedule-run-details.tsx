"use client";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import {
  runHref,
  runRowKind,
} from "@/app/projects/[id]/schedules/[triggerId]/run-row.utils";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import type { ScheduleTriggerRun } from "@/lib/schedule-trigger.query";
import { scheduleDateTime } from "./schedule-display.utils";
import { ScheduleRunBlockedDetails } from "./schedule-run-blocked-details";
import { ScheduleRunStatus } from "./schedule-run-status";
import { useResolveRunChat } from "./use-resolve-run-chat";

export function ScheduleRunDetails({
  run,
  timezone,
}: {
  run: ScheduleTriggerRun;
  timezone: string;
}) {
  const { resolve, isResolving } = useResolveRunChat();
  const href = runHref({ triggerId: run.triggerId, run });
  if (run.blockedBy)
    return (
      <div className="rounded-md border p-3">
        <ScheduleRunBlockedDetails triggerId={run.triggerId} run={run} />
      </div>
    );
  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3 text-xs">
      <ScheduleRunStatus run={run} />
      <dl className="grid grid-cols-2 gap-3">
        <div>
          <dt className="text-muted-foreground">Started</dt>
          <dd className="mt-1">
            {run.startedAt
              ? scheduleDateTime(run.startedAt, timezone)
              : "Waiting to start"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Finished</dt>
          <dd className="mt-1">
            {run.completedAt
              ? scheduleDateTime(run.completedAt, timezone)
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Trigger</dt>
          <dd className="mt-1">
            {run.runKind === "manual" ? "Manual" : "Scheduled"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Run ID</dt>
          <dd className="mt-1 font-mono" title={run.id}>
            {run.id.slice(0, 8)}
          </dd>
        </div>
      </dl>
      {run.error && (
        <InlineNotice variant="error">
          <InlineNoticeText>{run.error}</InlineNoticeText>
        </InlineNotice>
      )}
      <div className="flex items-center gap-2">
        {href ? (
          <Button size="xs" variant="outline" asChild>
            <Link href={href}>
              Open run
              <ArrowUpRight className="size-3" />
            </Link>
          </Button>
        ) : runRowKind(run) === "resolve" ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => resolve(run.triggerId, run.id)}
            disabled={isResolving}
          >
            {isResolving ? "Opening…" : "Open run"}
          </Button>
        ) : (
          <span className="text-muted-foreground">
            Waiting for execution to start.
          </span>
        )}
      </div>
    </div>
  );
}

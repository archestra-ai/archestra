"use client";

import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type ScheduleTriggerRun,
  useScheduleTrigger,
  useScheduleTriggerRun,
} from "@/lib/schedule-trigger.query";
import { scheduleRunDuration } from "./schedule-run-timeline.utils";

export function ScheduleRunBlockedDetails({
  run,
  triggerId,
  blockingRun,
}: {
  run: ScheduleTriggerRun;
  triggerId: string;
  blockingRun?: ScheduleTriggerRun;
}) {
  const blocker = run.blockedBy;
  const { data: fetchedBlockingRun } = useScheduleTriggerRun(
    triggerId,
    blocker?.runId ?? null,
    {
      enabled: !!blocker?.runId && !blockingRun && !blocker.runtimeTaskId,
      refetchInterval: (query) =>
        query.state.data?.status === "running" &&
        !query.state.data.runtimeTaskId &&
        !query.state.data.chatConversationId
          ? 5000
          : false,
    },
  );
  const currentBlockingRun = blockingRun ?? fetchedBlockingRun;
  const { data: trigger } = useScheduleTrigger(triggerId);
  const { data: canConfigure } = useHasPermissions(
    { agent: ["update"] },
    trigger?.agentId ?? "",
  );
  if (!blocker) return null;
  const taskId = currentBlockingRun?.runtimeTaskId ?? blocker.runtimeTaskId;
  return (
    <section className="space-y-3" aria-label="Skipped run details">
      <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 text-xs @2xl:grid-cols-4">
        {blocker.runId && (
          <div className="col-span-2 @sm:col-span-1">
            <dt className="text-muted-foreground">Blocking run</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-1">
              <code title={blocker.runId}>{blocker.runId.slice(0, 8)}</code>
              <CopyButton text={blocker.runId} />
              {currentBlockingRun &&
                currentBlockingRun.status !== "running" && (
                  <span className="text-muted-foreground">
                    {currentBlockingRun.status === "cancelled"
                      ? "Stopped since then"
                      : "Finished since then"}
                  </span>
                )}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground">Elapsed at skip</dt>
          <dd className="mt-1">
            {scheduleRunDuration(blocker.elapsedSeconds)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Maximum duration</dt>
          <dd className="mt-1">
            {blocker.maximumDurationSeconds
              ? scheduleRunDuration(blocker.maximumDurationSeconds)
              : "Unavailable at this tick"}
          </dd>
        </div>
        {blocker.deadline && (
          <div className="col-span-2 @sm:col-span-1">
            <dt className="text-muted-foreground">Blocking run deadline</dt>
            <dd className="mt-1">
              <time dateTime={blocker.deadline}>
                {new Date(blocker.deadline).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
            </dd>
          </div>
        )}
      </dl>
      {!blocker.deadline && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {blocker.phase === "running" && !blocker.runtimeTaskId
            ? "This run executes in chat; runtime Maximum duration does not apply."
            : "A runtime's Maximum duration deadline is available after launch."}
        </p>
      )}
      {blocker.phase === "stopping" && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Future scheduled runs wait until workload cleanup is confirmed.
        </p>
      )}
      <div className="flex flex-col items-start gap-2 @sm:flex-row @sm:flex-wrap @sm:items-center">
        {taskId && (
          <Button asChild size="xs" variant="outline">
            <Link href={`/chat/runs/${taskId}`}>Inspect previous run</Link>
          </Button>
        )}
        {currentBlockingRun?.chatConversationId && !taskId && (
          <Button asChild size="xs" variant="outline">
            <Link
              href={`/chat/${currentBlockingRun.chatConversationId}?scheduleTriggerId=${triggerId}&scheduleRunId=${currentBlockingRun.id}`}
            >
              Inspect previous run
            </Link>
          </Button>
        )}
        {canConfigure && trigger && (
          <Button asChild size="xs" variant="ghost">
            <Link href={`/agents/${trigger.agentId}/edit`}>
              Maximum duration settings
            </Link>
          </Button>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Timing records the skipped tick. Duration changes apply to future
        runtime sessions.
      </p>
      {!canConfigure && (
        <p className="text-xs text-muted-foreground">
          An agent editor can adjust Maximum duration in the agent settings.
        </p>
      )}
    </section>
  );
}

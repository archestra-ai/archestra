"use client";

import { Clock3 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type ScheduleTriggerRun,
  useScheduleTrigger,
  useScheduleTriggerRun,
} from "@/lib/schedule-trigger.query";

export function ScheduleRunBlockedNotice({
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
  const elapsed = duration(blocker.elapsedSeconds);
  return (
    <InlineNotice variant="warning">
      <Clock3 />
      <InlineNoticeBody>
        <span className="font-medium">Scheduled run skipped</span>
        <InlineNoticeText>
          <p>
            {blocker.phase === "starting"
              ? `The previous run was queued or starting for ${elapsed}.`
              : blocker.phase === "stopping"
                ? `The previous run was still stopping after ${elapsed}.`
                : `The previous run had been running for ${elapsed} when this run was due.`}
          </p>
          {blocker.runId && (
            <p className="break-all">Blocking run: {blocker.runId}</p>
          )}
          {blocker.deadline ? (
            <p>
              <span>
                Maximum duration
                {blocker.maximumDurationSeconds
                  ? `: ${duration(blocker.maximumDurationSeconds)}`
                  : ""}
                .{" "}
              </span>
              <span>Deadline: </span>
              <time dateTime={blocker.deadline}>
                {new Date(blocker.deadline).toLocaleString()}
              </time>
              <span>. This deadline belongs to the blocking run.</span>
            </p>
          ) : blocker.phase === "running" && !blocker.runtimeTaskId ? (
            <p>
              This run executes in chat; runtime Maximum duration does not
              apply.
            </p>
          ) : (
            <p>
              A runtime's Maximum duration deadline is available after launch.
            </p>
          )}
          <p>
            {blocker.phase === "stopping"
              ? "Future scheduled runs wait until workload cleanup is confirmed."
              : "Open the blocking run to inspect its output or stop it. Future scheduled runs resume after it finishes and cleanup completes."}
          </p>
          <p>Changing Maximum duration applies to future runtime sessions.</p>
          {!canConfigure && (
            <p>
              An agent editor can adjust Maximum duration in the agent settings.
            </p>
          )}
        </InlineNoticeText>
        <div className="mt-1 flex flex-wrap gap-2">
          {taskId && (
            <Button asChild size="xs" variant="outline">
              <Link href={`/chat/runs/${taskId}`}>Open blocking run</Link>
            </Button>
          )}
          {currentBlockingRun?.chatConversationId && !taskId && (
            <Button asChild size="xs" variant="outline">
              <Link
                href={`/chat/${currentBlockingRun.chatConversationId}?scheduleTriggerId=${triggerId}&scheduleRunId=${currentBlockingRun.id}`}
              >
                Open blocking run
              </Link>
            </Button>
          )}
          {canConfigure && trigger && (
            <Button asChild size="xs" variant="outline">
              <Link href={`/agents/${trigger.agentId}/edit`}>
                Configure Maximum duration
              </Link>
            </Button>
          )}
        </div>
      </InlineNoticeBody>
    </InlineNotice>
  );
}

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return "less than a minute";
  const hours = Math.floor(minutes / 60);
  return hours
    ? `${hours} ${hours === 1 ? "hour" : "hours"}${minutes % 60 ? ` ${minutes % 60} min` : ""}`
    : `${minutes} min`;
}

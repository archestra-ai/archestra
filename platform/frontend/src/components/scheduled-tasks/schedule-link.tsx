"use client";
import Link from "next/link";
import type { ComponentProps } from "react";
import { runHref } from "@/app/projects/[id]/schedules/[triggerId]/run-row.utils";
import {
  type ScheduleTrigger,
  useScheduleTriggerRuns,
} from "@/lib/schedule-trigger.query";

export function scheduleHistoryHref(schedule: ScheduleTrigger) {
  return schedule.projectId
    ? `/projects/${schedule.projectId}/schedules/${schedule.id}`
    : `/agents/${schedule.agentId}#agent-schedules`;
}
export function ScheduleLink({
  schedule,
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & { schedule: ScheduleTrigger }) {
  const { data } = useScheduleTriggerRuns(schedule.id, { limit: 1 });
  const run = data?.data[0];
  return (
    <Link
      prefetch={false}
      {...props}
      href={
        (run ? runHref({ triggerId: schedule.id, run }) : null) ??
        scheduleHistoryHref(schedule)
      }
    />
  );
}

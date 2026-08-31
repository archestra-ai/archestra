"use client";

import { Loader2, Play } from "lucide-react";
import { useParams } from "next/navigation";
import { LoadingState } from "@/components/loading";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { ScheduleRunsList } from "@/components/scheduled-tasks/schedule-runs-list";
import { Button } from "@/components/ui/button";
import { useProject } from "@/lib/projects/projects.query";
import {
  useRunScheduleTriggerNow,
  useScheduleTrigger,
} from "@/lib/schedule-trigger.query";
import { formatCronSchedule } from "@/lib/utils/format-cron";

export function ProjectScheduleRunsClient() {
  const { id: projectId, triggerId } = useParams<{
    id: string;
    triggerId: string;
  }>();

  const { data: project } = useProject(projectId);
  const { data: trigger, isLoading: triggerLoading } =
    useScheduleTrigger(triggerId);
  const runNowMutation = useRunScheduleTriggerNow();

  const projectName = project?.name ?? "Project";
  const triggerName = trigger?.name ?? "Schedule";

  const onRunNow = () => {
    runNowMutation.mutate(triggerId);
  };

  if (triggerLoading) {
    return <LoadingState label="Loading schedule runs…" variant="viewport" />;
  }

  return (
    <PageLayout
      title={`${triggerName} — Runs`}
      description={
        trigger ? (
          <>
            {trigger.agent?.name ?? "Default agent"} ·{" "}
            {formatCronSchedule(trigger.cronExpression)} · {trigger.timezone}
          </>
        ) : undefined
      }
      backLink={
        <PageBackLink href={`/projects/${projectId}`}>
          {projectName}
        </PageBackLink>
      }
      actionButton={
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
          <span>Run now</span>
        </Button>
      }
      maxWidth="wizard"
    >
      <ScheduleRunsList triggerId={triggerId} />
    </PageLayout>
  );
}

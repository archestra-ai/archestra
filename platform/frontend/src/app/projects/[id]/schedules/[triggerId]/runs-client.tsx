"use client";

import { ArrowLeft, Loader2, Play } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
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

      <ScheduleRunsList triggerId={triggerId} />
    </div>
  );
}

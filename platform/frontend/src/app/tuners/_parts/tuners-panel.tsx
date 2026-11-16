"use client";

import { Play, Settings2 } from "lucide-react";
import { useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { isValidCronExpression } from "@/components/scheduled-tasks/schedule-trigger.utils";
import { ScheduleTriggerPicker } from "@/components/scheduled-tasks/schedule-trigger-picker";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  type TunerSummary,
  useConfigureTuner,
  useRunTuner,
  useTuners,
} from "@/lib/tuners.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { formatCronSchedule } from "@/lib/utils/format-cron";
import { browserTimeZone } from "@/lib/utils/time-zone";
import { RUN_STATUS_LABEL, runOutcomeLabel, TUNER_LABEL } from "./tuner-labels";

export function TunersPanel({ canUpdate }: { canUpdate: boolean }) {
  const tuners = useTuners();
  return (
    <section aria-labelledby="tuners-heading" className="space-y-3">
      <h2 id="tuners-heading" className="text-base font-semibold">
        Tuners
      </h2>
      {tuners.isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : tuners.isError ? (
        <QueryLoadError
          title="Couldn't load tuners"
          error={tuners.error}
          onRetry={() => tuners.refetch()}
          className="h-auto"
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {tuners.data.map((tuner) => (
            <TunerCard key={tuner.kind} tuner={tuner} canUpdate={canUpdate} />
          ))}
        </div>
      )}
    </section>
  );
}

// === Internal helpers

function TunerCard({
  tuner,
  canUpdate,
}: {
  tuner: TunerSummary;
  canUpdate: boolean;
}) {
  const configure = useConfigureTuner();
  const run = useRunTuner();
  const [editing, setEditing] = useState(false);
  const { trigger, lastRun, available } = tuner;
  const enabled = trigger?.enabled ?? false;
  const label = TUNER_LABEL[tuner.kind];
  const actor = trigger?.actor?.name ?? trigger?.actor?.email ?? null;

  return (
    <Card aria-label={label} className="gap-4">
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>
          {available ? (
            <span>
              {trigger
                ? `${formatCronSchedule(trigger.cronExpression)} · ${trigger.timezone}`
                : "Not scheduled yet"}
            </span>
          ) : (
            <span>Not available in this deployment</span>
          )}
        </CardDescription>
        <CardAction>
          <Switch
            aria-label={`Enable ${label}`}
            checked={enabled}
            disabled={
              !canUpdate || configure.isPending || (!available && !enabled)
            }
            onCheckedChange={(next) =>
              configure.mutate({ kind: tuner.kind, body: { enabled: next } })
            }
          />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        <Detail label="Runs as">{actor ?? "Whoever enables it"}</Detail>
        <Detail label="Last run">
          {lastRun ? (
            <span>
              {[
                RUN_STATUS_LABEL[lastRun.status],
                lastRun.scan && runOutcomeLabel(lastRun.scan),
                formatRelativeTimeFromNow(lastRun.createdAt),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : (
            <span>Never</span>
          )}
        </Detail>
        {lastRun?.error ? (
          <p className="break-words text-destructive">{lastRun.error}</p>
        ) : null}
      </CardContent>
      {canUpdate ? (
        <CardFooter className="gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!available}
            onClick={() => setEditing(true)}
          >
            <Settings2 />
            <span>Schedule</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!available || !trigger || run.isPending}
            onClick={() => run.mutate(tuner.kind)}
          >
            <Play />
            <span>Run now</span>
          </Button>
        </CardFooter>
      ) : null}
      {editing ? (
        <ScheduleDialog tuner={tuner} onClose={() => setEditing(false)} />
      ) : null}
    </Card>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function ScheduleDialog({
  tuner,
  onClose,
}: {
  tuner: TunerSummary;
  onClose: () => void;
}) {
  const configure = useConfigureTuner();
  const [value, setValue] = useState({
    enabled: tuner.trigger?.enabled ?? true,
    cronExpression: tuner.trigger?.cronExpression ?? DEFAULT_CRON,
    timezone: tuner.trigger?.timezone ?? browserTimeZone(),
  });
  const valid = !value.enabled || isValidCronExpression(value.cronExpression);

  return (
    <StandardFormDialog
      open
      onOpenChange={(open) => {
        if (!open && !configure.isPending) onClose();
      }}
      title={`${TUNER_LABEL[tuner.kind]} schedule`}
      description="Turning the schedule on makes you the user this tuner runs as."
      size="medium"
      onSubmit={(event) => {
        event.preventDefault();
        configure.mutate(
          { kind: tuner.kind, body: value },
          { onSuccess: onClose },
        );
      }}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={configure.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!valid || configure.isPending}>
            <span>{configure.isPending ? "Saving…" : "Save"}</span>
          </Button>
        </>
      }
    >
      <ScheduleTriggerPicker value={value} onChange={setValue} />
    </StandardFormDialog>
  );
}

const DEFAULT_CRON = "0 6 * * *";

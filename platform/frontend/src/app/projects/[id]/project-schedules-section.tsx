"use client";

import {
  CalendarClock,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { runHref } from "@/app/projects/[id]/schedules/[triggerId]/run-row.utils";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ScheduleDialog } from "@/components/scheduled-tasks/schedule-dialog";
import { useResolveRunChat } from "@/components/scheduled-tasks/use-resolve-run-chat";
import { useStartScheduleRun } from "@/components/scheduled-tasks/use-start-schedule-run";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import {
  type ScheduleTrigger,
  useDeleteScheduleTrigger,
  useDisableScheduleTrigger,
  useEnableScheduleTrigger,
  useScheduleTrigger,
  useScheduleTriggerRuns,
  useScheduleTriggers,
} from "@/lib/schedule-trigger.query";
import { formatCronSchedule } from "@/lib/utils/format-cron";
import { cn } from "@/lib/utils/tailwind";

/**
 * Schedules that belong to a project: recurring agent runs whose chats land in
 * the project's session list. Replaces the standalone Scheduled page for
 * project-scoped tasks.
 */
export function ProjectSchedulesSection({
  projectId,
  /**
   * Creating a schedule would mint new chats in the project, so an admin
   * overseeing someone else's project can manage existing schedules but not add
   * new ones. Defaults to true (owner / shared collaborator).
   */
  canCreate = true,
  /** The project's pinned agent, preselected when creating a schedule. */
  defaultAgentId = null,
}: {
  projectId: string;
  canCreate?: boolean;
  defaultAgentId?: string | null;
}) {
  const { data: canReadSchedules } = useHasPermissions({
    project: ["read"],
  });
  if (canReadSchedules !== true) return null;

  return (
    <ProjectSchedulesSectionContent
      projectId={projectId}
      canCreate={canCreate}
      defaultAgentId={defaultAgentId}
    />
  );
}

function ProjectSchedulesSectionContent({
  projectId,
  canCreate,
  defaultAgentId,
}: {
  projectId: string;
  canCreate: boolean;
  defaultAgentId: string | null;
}) {
  const { data, isPending, isError } = useScheduleTriggers({
    projectId,
    refetchInterval: 10000,
  });
  const { data: canCreateSchedules } = useHasPermissions({
    project: ["create"],
  });
  const { data: session } = useSession();
  const { data: capabilities } = useScopedCapabilities();
  const hasOversight = (action: "update" | "delete" | "use") =>
    capabilities?.some(
      (grant) =>
        grant.resource === "project" &&
        grant.scope === "*" &&
        grant.action === action,
    ) === true;
  const [createOpen, setCreateOpen] = useState(false);
  const searchParams = useSearchParams();
  const scheduleId = searchParams.get("schedule");
  const { data: scheduleFromUrl } = useScheduleTrigger(scheduleId);
  const {
    entity: editingSchedule,
    open: openEditDialog,
    close: closeEditDialog,
  } = useDialogUrlParam<ScheduleTrigger>({
    paramName: "schedule",
    entityFromUrl: scheduleFromUrl ?? null,
  });
  const schedules = data?.data ?? [];
  const { data: canUpdateSchedules } = useHasPermissions({
    project: ["update"],
  });
  const { data: canDeleteSchedules } = useHasPermissions({
    project: ["delete"],
  });

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Schedules</h2>
          {!isPending && !isError && schedules.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {schedules.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canCreate && canCreateSchedules === true && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="size-3.5" />
              <span>New schedule</span>
            </Button>
          )}
        </div>
      </div>

      {createOpen && (
        <ScheduleDialog
          projectId={projectId}
          defaultAgentId={defaultAgentId}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      )}

      {editingSchedule && (
        <ScheduleDialog
          projectId={editingSchedule.projectId ?? ""}
          schedule={editingSchedule}
          open
          onOpenChange={(open) => {
            if (!open) closeEditDialog();
          }}
        />
      )}

      {isPending ? (
        <p className="py-3 text-sm text-muted-foreground">Loading schedules…</p>
      ) : isError ? (
        <p className="py-3 text-sm text-muted-foreground">
          Schedules could not be loaded.
        </p>
      ) : schedules.length === 0 ? (
        <div className="rounded-lg border border-dashed px-3 py-4">
          <p className="text-sm font-medium">No schedules yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Run an agent here on a schedule or whenever you need it.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              projectId={projectId}
              schedule={schedule}
              onEdit={openEditDialog}
              canEdit={
                canUpdateSchedules === true &&
                (schedule.actorUserId === session?.user.id ||
                  hasOversight("update"))
              }
              canDelete={
                canDeleteSchedules === true &&
                (schedule.actorUserId === session?.user.id ||
                  hasOversight("delete"))
              }
              runBlockedReason={
                canCreateSchedules !== true
                  ? "You can't run schedules. Ask an admin if you need to."
                  : schedule.actorUserId === session?.user.id ||
                      hasOversight("use")
                    ? null
                    : `Set up by ${schedule.actor?.name ?? "someone else"}. Only they or an admin can run it.`
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}

// === internal components ===

function ScheduleRow({
  projectId,
  schedule,
  onEdit,
  canEdit,
  canDelete,
  runBlockedReason,
}: {
  projectId: string;
  schedule: ScheduleTrigger;
  onEdit: (schedule: ScheduleTrigger) => void;
  canEdit: boolean;
  canDelete: boolean;
  /** Why this person may not start the schedule now, or null when they may. */
  runBlockedReason: string | null;
}) {
  const enableSchedule = useEnableScheduleTrigger();
  const disableSchedule = useDisableScheduleTrigger();
  const deleteSchedule = useDeleteScheduleTrigger();
  const runNow = useStartScheduleRun(schedule.id);
  const router = useRouter();
  const { resolve, isResolving } = useResolveRunChat();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { data: runs, isPending: loadingRuns } = useScheduleTriggerRuns(
    schedule.id,
    {
      limit: 1,
      refetchInterval: 10000,
    },
  );
  const openRuns = () => {
    const run = runs?.data[0];
    const href = run ? runHref({ triggerId: schedule.id, run }) : null;
    if (href) router.push(href);
    else if (run && run.status !== "running") resolve(schedule.id, run.id);
    else router.push(`/projects/${projectId}/schedules/${schedule.id}`);
  };
  return (
    <div className="rounded-lg border px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10",
            !schedule.enabled && "bg-muted",
          )}
        >
          <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span
              className="truncate text-sm font-medium"
              title={schedule.name}
            >
              {schedule.name}
            </span>
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {schedule.enabled ? "Active" : "Paused"}
            </Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {schedule.agent?.name ?? "Default agent"}
          </p>
          <p
            className="mt-1 truncate text-xs text-muted-foreground"
            title={`${formatCronSchedule(schedule.cronExpression)} · ${schedule.timezone}`}
          >
            {formatCronSchedule(schedule.cronExpression)} · {schedule.timezone}
          </p>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1 border-t pt-2">
        <Button
          variant="ghost"
          size="xs"
          aria-label={`View runs for ${schedule.name}`}
          onClick={openRuns}
          disabled={loadingRuns || isResolving}
        >
          Runs
        </Button>
        {canEdit && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onEdit(schedule)}
            aria-label={`Edit ${schedule.name}`}
          >
            Edit
          </Button>
        )}
        {canEdit && (
          <Button
            variant="ghost"
            size="xs"
            disabled={enableSchedule.isPending || disableSchedule.isPending}
            onClick={() =>
              (schedule.enabled ? disableSchedule : enableSchedule).mutate(
                schedule.id,
              )
            }
            aria-label={`${schedule.enabled ? "Pause" : "Resume"} ${schedule.name}`}
          >
            {schedule.enabled ? (
              <Pause className="size-3.5" />
            ) : (
              <Play className="size-3.5" />
            )}
            <span>{schedule.enabled ? "Pause" : "Resume"}</span>
          </Button>
        )}
        <div className="ml-auto" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              aria-label={`Actions for ${schedule.name}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={runBlockedReason !== null || runNow.isPending}
              onSelect={runNow.start}
            >
              <Play className="h-4 w-4" />
              {runBlockedReason ? (
                <span className="flex flex-col items-start gap-0.5">
                  <span>Run now</span>
                  <span className="text-xs text-muted-foreground">
                    {runBlockedReason}
                  </span>
                </span>
              ) : (
                <span>Run now</span>
              )}
            </DropdownMenuItem>
            {canDelete && (
              <DropdownMenuItem
                variant="destructive"
                disabled={deleteSchedule.isPending}
                onSelect={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
                Delete schedule
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {deleteOpen && (
        <DeleteConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={`Delete ${schedule.name}?`}
          description="This removes the schedule and its run history. Chats and sessions already created by its runs remain in the project."
          isPending={deleteSchedule.isPending}
          onConfirm={() =>
            deleteSchedule.mutate(schedule.id, {
              onSuccess: (result) => {
                if (result?.success) setDeleteOpen(false);
              },
            })
          }
        />
      )}
    </div>
  );
}

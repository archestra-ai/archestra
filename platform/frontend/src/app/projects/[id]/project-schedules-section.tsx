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
import { useMemo, useState } from "react";
import { runHref } from "@/app/projects/[id]/schedules/[triggerId]/run-row.utils";
import { AgentSelector } from "@/components/agent-selector";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  DEFAULT_FORM_STATE,
  isValidCronExpression,
  type ScheduleTriggerFormState,
} from "@/components/scheduled-tasks/schedule-trigger.utils";
import { ScheduleTriggerPicker } from "@/components/scheduled-tasks/schedule-trigger-picker";
import { useResolveRunChat } from "@/components/scheduled-tasks/use-resolve-run-chat";
import { useStartScheduleRun } from "@/components/scheduled-tasks/use-start-schedule-run";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import {
  type ScheduleTrigger,
  useCreateScheduleTrigger,
  useDeleteScheduleTrigger,
  useDisableScheduleTrigger,
  useEnableScheduleTrigger,
  useScheduleTrigger,
  useScheduleTriggerRuns,
  useScheduleTriggers,
  useUpdateScheduleTrigger,
} from "@/lib/schedule-trigger.query";
import { cn } from "@/lib/utils";
import { formatCronSchedule } from "@/lib/utils/format-cron";

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
  // Without scheduledTask:read the schedules query can only 403 (and it polls,
  // so it would toast the permission error forever). Hide the section and
  // never mount the query for roles that can't see schedules.
  const { data: canReadSchedules } = useHasPermissions({
    scheduledTask: ["read"],
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
    scheduledTask: ["create"],
  });
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
    scheduledTask: ["update"],
  });
  const { data: canDeleteSchedules } = useHasPermissions({
    scheduledTask: ["delete"],
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
        {canCreate && canCreateSchedules === true && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs has-[>svg]:px-2"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-3.5" />
            <span>New schedule</span>
          </Button>
        )}
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
              canEdit={canUpdateSchedules === true}
              canDelete={canDeleteSchedules === true}
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
}: {
  projectId: string;
  schedule: ScheduleTrigger;
  onEdit: (schedule: ScheduleTrigger) => void;
  canEdit: boolean;
  canDelete: boolean;
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
          size="sm"
          className="h-7 px-2 text-xs"
          aria-label={`View runs for ${schedule.name}`}
          onClick={openRuns}
          disabled={loadingRuns || isResolving}
        >
          Runs
        </Button>
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onEdit(schedule)}
            aria-label={`Edit ${schedule.name}`}
          >
            Edit
          </Button>
        )}
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
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
              size="icon"
              className="h-7 w-7 shrink-0"
              aria-label={`Actions for ${schedule.name}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={runNow.isPending}
              onSelect={runNow.start}
            >
              <Play className="h-4 w-4" />
              Run now
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

function ScheduleDialog({
  projectId,
  schedule,
  defaultAgentId = null,
  open,
  onOpenChange,
}: {
  projectId: string;
  /** Present in edit mode; absent when creating. */
  schedule?: ScheduleTrigger;
  /** The project's pinned agent; seeds a new schedule, never an edit. */
  defaultAgentId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isEditing = !!schedule;
  // The agent picker is a management capability; without `agent:read` the
  // dropdown is hidden and the run implicitly uses the org's default agent.
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: agents = [] } = useProfiles({
    filters: { agentType: "agent" },
    enabled: canReadAgents === true,
  });
  const createSchedule = useCreateScheduleTrigger();
  const updateSchedule = useUpdateScheduleTrigger();
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);
  const [form, setForm] = useState<ScheduleTriggerFormState>(() =>
    schedule
      ? {
          name: schedule.name,
          agentId: schedule.agentId,
          cronExpression: schedule.cronExpression,
          timezone: schedule.timezone,
          messageTemplate: schedule.messageTemplate,
        }
      : { ...DEFAULT_FORM_STATE(), agentId: defaultAgentId ?? "" },
  );

  // Hide other people's personal agents, like the standalone scheduled page.
  const selectableAgents = useMemo(
    () =>
      agents.filter(
        (agent) =>
          agent.scope !== "personal" || agent.authorId === currentUserId,
      ),
    [agents, currentUserId],
  );

  const update = (patch: Partial<ScheduleTriggerFormState>) =>
    setForm((current) => ({ ...current, ...patch }));

  const isValid =
    form.name.trim().length > 0 &&
    form.messageTemplate.trim().length > 0 &&
    isValidCronExpression(form.cronExpression) &&
    (canReadAgents !== true || form.agentId.length > 0);
  const isPending = createSchedule.isPending || updateSchedule.isPending;

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isValid) return;
    // Only send agentId when the user can pick one; otherwise leave it to the
    // org default (create) or unchanged (edit).
    const agentFields =
      canReadAgents === true && form.agentId ? { agentId: form.agentId } : {};
    const fields = {
      name: form.name.trim(),
      enabled,
      messageTemplate: form.messageTemplate.trim(),
      cronExpression: form.cronExpression.trim(),
      timezone: form.timezone.trim(),
      ...agentFields,
    };

    const result =
      schedule !== undefined
        ? await updateSchedule.mutateAsync({ id: schedule.id, body: fields })
        : await createSchedule.mutateAsync({ ...fields, projectId });
    if (result) {
      if (!isEditing)
        setForm({ ...DEFAULT_FORM_STATE(), agentId: defaultAgentId ?? "" });
      onOpenChange(false);
    }
  };

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEditing ? "Edit schedule" : "New schedule"}
      description="Run an agent manually or on a recurring schedule in this project."
      size="medium"
      onSubmit={onSubmit}
      bodyClassName="space-y-3"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isPending || !isValid}>
            {isEditing ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-1.5">
        <Label htmlFor="schedule-name">Name</Label>
        <Input
          id="schedule-name"
          value={form.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="Weekly summary"
          maxLength={256}
        />
      </div>

      {canReadAgents === true && (
        <div className="space-y-1.5">
          <Label>Agent</Label>
          <AgentSelector
            mode="single"
            flat
            agents={selectableAgents}
            value={form.agentId}
            onValueChange={(value) => update({ agentId: value })}
            placeholder="Select an agent"
            className="w-full"
          />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="schedule-prompt">Task prompt</Label>
        <Textarea
          id="schedule-prompt"
          value={form.messageTemplate}
          onChange={(e) => update({ messageTemplate: e.target.value })}
          placeholder="What should the agent do on each run?"
          rows={6}
        />
      </div>

      <div className="space-y-1.5">
        <ScheduleTriggerPicker
          value={{
            enabled,
            cronExpression: form.cronExpression,
            timezone: form.timezone,
          }}
          onChange={(next) => {
            setEnabled(next.enabled);
            update({
              cronExpression: next.cronExpression,
              timezone: next.timezone,
            });
          }}
        />
      </div>
    </StandardFormDialog>
  );
}

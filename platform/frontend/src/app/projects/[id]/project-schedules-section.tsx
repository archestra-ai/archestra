"use client";

import {
  CalendarClock,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Power,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { runChatHref } from "@/app/projects/[id]/schedules/[triggerId]/run-row.utils";
import {
  DEFAULT_FORM_STATE,
  isValidCronExpression,
  type ScheduleTriggerFormState,
} from "@/app/scheduled-tasks/schedule-trigger.utils";
import { AgentSelector } from "@/components/agent-selector";
import { useResolveRunChat } from "@/components/scheduled-tasks/use-resolve-run-chat";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CronExpressionPicker,
  DEFAULT_CRON_PRESET_OPTIONS,
} from "@/components/ui/cron-expression-picker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TimezonePicker } from "@/components/ui/timezone-picker";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  type ScheduleTrigger,
  useCreateScheduleTrigger,
  useDeleteScheduleTrigger,
  useDisableScheduleTrigger,
  useEnableScheduleTrigger,
  useRunScheduleTriggerNow,
  useScheduleTriggerRuns,
  useScheduleTriggers,
  useUpdateScheduleTrigger,
} from "@/lib/schedule-trigger.query";
import { cn } from "@/lib/utils";

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
}: {
  projectId: string;
  canCreate?: boolean;
}) {
  const { data } = useScheduleTriggers({ projectId, refetchInterval: 10000 });
  const [createOpen, setCreateOpen] = useState(false);
  const schedules = data?.data ?? [];

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Schedules
        </h2>
        {canCreate && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            New schedule
          </Button>
        )}
      </div>

      {createOpen && (
        <ScheduleDialog
          projectId={projectId}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      )}

      {schedules.length === 0 ? (
        <p className="rounded-xl border px-3 py-6 text-center text-sm text-muted-foreground">
          No schedules yet — recurring runs you add here show up in this
          project's chats.
        </p>
      ) : (
        <div className="space-y-2">
          {schedules.map((schedule) => (
            <ScheduleRow key={schedule.id} schedule={schedule} />
          ))}
        </div>
      )}
    </section>
  );
}

// === internal components ===

function ScheduleRow({ schedule }: { schedule: ScheduleTrigger }) {
  const enableSchedule = useEnableScheduleTrigger();
  const disableSchedule = useDisableScheduleTrigger();
  const deleteSchedule = useDeleteScheduleTrigger();
  const runNow = useRunScheduleTriggerNow();
  const [editOpen, setEditOpen] = useState(false);

  const { resolve, isResolving } = useResolveRunChat();
  // Clicking the schedule opens its LAST run's chat. Fetch just that run (no
  // polling — the section already refreshes the trigger list).
  const { data: runsResponse } = useScheduleTriggerRuns(schedule.id, {
    limit: 1,
    refetchInterval: false,
  });
  const lastRun = runsResponse?.data?.[0];

  const labelClassName = cn(
    "min-w-0 flex-1 hover:opacity-80 transition-opacity",
    !schedule.enabled && "opacity-60",
  );
  const scheduleLabel = (
    <>
      <span className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{schedule.name}</span>
        {!schedule.enabled && (
          <Badge variant="outline" className="shrink-0">
            Disabled
          </Badge>
        )}
      </span>
      <span className="block truncate text-xs text-muted-foreground">
        {schedule.agent?.name ?? "Default agent"}
      </span>
    </>
  );

  const lastRunChatHref = lastRun
    ? runChatHref({ triggerId: schedule.id, run: lastRun })
    : null;
  // Last run has a chat → link straight to it. Last run without one (legacy) →
  // create it on click, then open. No runs/chats yet → plain label that does
  // nothing (the empty runs page has nothing to show); "Run manually" in the
  // overflow menu is how you kick off the first run.
  let nameNode: React.ReactNode;
  if (lastRunChatHref) {
    nameNode = (
      <Link href={lastRunChatHref} className={labelClassName}>
        {scheduleLabel}
      </Link>
    );
  } else if (lastRun) {
    nameNode = (
      <button
        type="button"
        disabled={isResolving}
        className={cn(labelClassName, "text-left")}
        onClick={() => resolve(schedule.id, lastRun.id)}
      >
        {scheduleLabel}
      </button>
    );
  } else {
    nameNode = (
      <div className={cn("min-w-0 flex-1", !schedule.enabled && "opacity-60")}>
        {scheduleLabel}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10",
          !schedule.enabled && "bg-muted",
        )}
      >
        <CalendarClock
          className={cn(
            "h-4 w-4 text-primary",
            !schedule.enabled && "text-muted-foreground",
          )}
          aria-hidden
        />
      </span>
      {nameNode}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Schedule actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={runNow.isPending}
            onSelect={() => runNow.mutate(schedule.id)}
          >
            <Play className="h-4 w-4" />
            Run manually
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              schedule.enabled
                ? disableSchedule.mutate(schedule.id)
                : enableSchedule.mutate(schedule.id)
            }
          >
            {schedule.enabled ? (
              <>
                <Power className="h-4 w-4" />
                Disable
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Enable
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>
            <Pencil className="h-4 w-4" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => deleteSchedule.mutate(schedule.id)}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {editOpen && (
        <ScheduleDialog
          projectId={schedule.projectId ?? ""}
          schedule={schedule}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
      )}
    </div>
  );
}

function ScheduleDialog({
  projectId,
  schedule,
  open,
  onOpenChange,
}: {
  projectId: string;
  /** Present in edit mode; absent when creating. */
  schedule?: ScheduleTrigger;
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
  const [form, setForm] = useState<ScheduleTriggerFormState>(() =>
    schedule
      ? {
          name: schedule.name,
          agentId: schedule.agentId,
          cronExpression: schedule.cronExpression,
          timezone: schedule.timezone,
          messageTemplate: schedule.messageTemplate,
        }
      : DEFAULT_FORM_STATE(),
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
      if (!isEditing) setForm(DEFAULT_FORM_STATE());
      onOpenChange(false);
    }
  };

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEditing ? "Edit schedule" : "New schedule"}
      description="Run an agent on a recurring schedule. Each run starts a chat in this project."
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
        <Label>Schedule</Label>
        <CronExpressionPicker
          value={form.cronExpression}
          onChange={(value) => update({ cronExpression: value })}
          presets={DEFAULT_CRON_PRESET_OPTIONS}
          className="w-full"
        />
      </div>

      <div className="space-y-1.5">
        <Label>Timezone</Label>
        <TimezonePicker
          value={form.timezone}
          onValueChange={(value) => update({ timezone: value })}
          className="w-full"
        />
      </div>
    </StandardFormDialog>
  );
}

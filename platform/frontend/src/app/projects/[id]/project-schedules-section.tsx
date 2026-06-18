"use client";

import { CalendarClock, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  buildScheduleTriggerPayload,
  DEFAULT_FORM_STATE,
  type ScheduleTriggerFormState,
} from "@/app/scheduled-tasks/schedule-trigger.utils";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useInternalAgents } from "@/lib/agent.query";
import {
  type ScheduleTrigger,
  useCreateScheduleTrigger,
  useDeleteScheduleTrigger,
  useDisableScheduleTrigger,
  useEnableScheduleTrigger,
  useScheduleTriggers,
} from "@/lib/schedule-trigger.query";
import { formatCronSchedule } from "@/lib/utils/format-cron";

/**
 * Schedules that belong to a project: recurring agent runs whose chats land in
 * the project's session list. Replaces the standalone Scheduled page for
 * project-scoped tasks.
 */
export function ProjectSchedulesSection({ projectId }: { projectId: string }) {
  const { data } = useScheduleTriggers({ projectId, refetchInterval: 10000 });
  const [createOpen, setCreateOpen] = useState(false);
  const schedules = data?.data ?? [];

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Schedules
        </h2>
        <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          New schedule
        </Button>
      </div>

      {createOpen && (
        <CreateScheduleDialog
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

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <CalendarClock className="h-4 w-4 text-primary" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {schedule.name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {formatCronSchedule(schedule.cronExpression)}
          {schedule.agent?.name ? ` · ${schedule.agent.name}` : ""}
        </span>
      </span>
      <Switch
        checked={schedule.enabled}
        onCheckedChange={(checked) =>
          checked
            ? enableSchedule.mutate(schedule.id)
            : disableSchedule.mutate(schedule.id)
        }
        aria-label={schedule.enabled ? "Disable schedule" : "Enable schedule"}
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label="Delete schedule"
        onClick={() => deleteSchedule.mutate(schedule.id)}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function CreateScheduleDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: agents } = useInternalAgents();
  const createSchedule = useCreateScheduleTrigger();
  const [form, setForm] = useState<ScheduleTriggerFormState>(
    DEFAULT_FORM_STATE(),
  );

  const payload = buildScheduleTriggerPayload(form);
  const update = (patch: Partial<ScheduleTriggerFormState>) =>
    setForm((current) => ({ ...current, ...patch }));

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!payload) return;
    const created = await createSchedule.mutateAsync({ ...payload, projectId });
    if (created) {
      setForm(DEFAULT_FORM_STATE());
      onOpenChange(false);
    }
  };

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New schedule"
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
          <Button
            type="submit"
            disabled={createSchedule.isPending || payload === null}
          >
            Create
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

      <div className="space-y-1.5">
        <Label>Agent</Label>
        <Select
          value={form.agentId}
          onValueChange={(value) => update({ agentId: value })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select an agent" />
          </SelectTrigger>
          <SelectContent>
            {(agents ?? []).map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="schedule-message">Message</Label>
        <Textarea
          id="schedule-message"
          value={form.messageTemplate}
          onChange={(e) => update({ messageTemplate: e.target.value })}
          placeholder="What should the agent do on each run?"
          rows={3}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="schedule-cron">Schedule (cron)</Label>
          <Input
            id="schedule-cron"
            value={form.cronExpression}
            onChange={(e) => update({ cronExpression: e.target.value })}
            placeholder="0 9 * * 1-5"
          />
          <p className="text-xs text-muted-foreground">
            {formatCronSchedule(form.cronExpression)}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="schedule-timezone">Timezone</Label>
          <Input
            id="schedule-timezone"
            value={form.timezone}
            onChange={(e) => update({ timezone: e.target.value })}
            placeholder="UTC"
          />
        </div>
      </div>
    </StandardFormDialog>
  );
}

"use client";

import { CalendarClock, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  DEFAULT_FORM_STATE,
  isValidCronExpression,
  type ScheduleTriggerFormState,
} from "@/app/scheduled-tasks/schedule-trigger.utils";
import { AgentIcon } from "@/components/agent-icon";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  CronExpressionPicker,
  DEFAULT_CRON_PRESET_OPTIONS,
} from "@/components/ui/cron-expression-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  type ScheduleTrigger,
  useCreateScheduleTrigger,
  useDeleteScheduleTrigger,
  useDisableScheduleTrigger,
  useEnableScheduleTrigger,
  useScheduleTriggers,
} from "@/lib/schedule-trigger.query";

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
          {schedule.agent?.name ?? "Default agent"}
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
  const [form, setForm] = useState<ScheduleTriggerFormState>(
    DEFAULT_FORM_STATE(),
  );

  const agentOptions = useMemo(
    () =>
      agents
        .filter(
          (agent) =>
            agent.scope !== "personal" || agent.authorId === currentUserId,
        )
        .map((agent) => ({
          value: agent.id,
          label: agent.name || "Untitled agent",
          description:
            agent.scope === "personal"
              ? "Personal agent"
              : `${agent.scope} agent`,
          content: (
            <span className="flex items-center gap-2">
              <AgentIcon icon={agent.icon} size={16} />
              {agent.name || "Untitled agent"}
            </span>
          ),
        })),
    [agents, currentUserId],
  );

  const update = (patch: Partial<ScheduleTriggerFormState>) =>
    setForm((current) => ({ ...current, ...patch }));

  const isValid =
    form.name.trim().length > 0 &&
    form.messageTemplate.trim().length > 0 &&
    isValidCronExpression(form.cronExpression) &&
    (canReadAgents !== true || form.agentId.length > 0);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isValid) return;
    const created = await createSchedule.mutateAsync({
      name: form.name.trim(),
      messageTemplate: form.messageTemplate.trim(),
      cronExpression: form.cronExpression.trim(),
      timezone: form.timezone.trim(),
      projectId,
      // Omit when the user can't pick — the backend uses the org default agent.
      ...(canReadAgents === true && form.agentId
        ? { agentId: form.agentId }
        : {}),
    });
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
          <Button type="submit" disabled={createSchedule.isPending || !isValid}>
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

      {canReadAgents === true && (
        <div className="space-y-1.5">
          <Label>Agent</Label>
          <SearchableSelect
            value={form.agentId}
            onValueChange={(value) => update({ agentId: value })}
            items={agentOptions}
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
          rows={3}
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
    </StandardFormDialog>
  );
}

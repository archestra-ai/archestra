"use client";

import { type ReactNode, useRef, useState } from "react";
import { AgentSelector } from "@/components/agent-selector";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type ScheduleTrigger,
  useCreateScheduleTrigger,
  useUpdateScheduleTrigger,
} from "@/lib/schedule-trigger.query";
import {
  DEFAULT_FORM_STATE,
  isValidCronExpression,
  type ScheduleTriggerFormState,
} from "./schedule-trigger.utils";
import { ScheduleTriggerPicker } from "./schedule-trigger-picker";

export type ScheduleDialogDefaults = Partial<
  ScheduleTriggerFormState & { enabled: boolean }
>;

export function ScheduleDialog({
  projectId,
  schedule,
  defaultAgentId = null,
  open,
  onOpenChange,
  title,
  description = "Run an agent manually or on a recurring schedule in this project.",
  submitLabel,
  initialValues,
  fixedAgent,
  projectField,
  resolveProjectId,
  onSaved,
  disabledReason,
}: {
  projectId?: string;
  /** Present in edit mode; absent when creating. */
  schedule?: ScheduleTrigger;
  /** The project's pinned agent; seeds a new schedule, never an edit. */
  defaultAgentId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  submitLabel?: string;
  initialValues?: ScheduleDialogDefaults;
  fixedAgent?: { id: string; name: string };
  /** Caller-owned project selection; omitted in an existing project. */
  projectField?: ReactNode;
  /** Resolves or creates the destination only when the form is submitted. */
  resolveProjectId?: () => Promise<string>;
  onSaved?: (schedule: ScheduleTrigger) => void;
  disabledReason?: string;
}) {
  const isEditing = !!schedule;
  // The agent picker is a management capability; without `agent:read` the
  // dropdown is hidden and the run implicitly uses the org's default agent.
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });
  const createSchedule = useCreateScheduleTrigger();
  const updateSchedule = useUpdateScheduleTrigger();
  const [enabled, setEnabled] = useState(
    schedule?.enabled ?? initialValues?.enabled ?? false,
  );
  const [form, setForm] = useState<ScheduleTriggerFormState>(() =>
    schedule
      ? {
          name: schedule.name,
          agentId: schedule.agentId,
          cronExpression: schedule.cronExpression,
          timezone: schedule.timezone,
          messageTemplate: schedule.messageTemplate,
        }
      : {
          ...DEFAULT_FORM_STATE(),
          ...initialValues,
          agentId:
            fixedAgent?.id ?? defaultAgentId ?? initialValues?.agentId ?? "",
        },
  );

  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  const update = (patch: Partial<ScheduleTriggerFormState>) =>
    setForm((current) => ({ ...current, ...patch }));

  const isValid =
    form.name.trim().length > 0 &&
    form.messageTemplate.trim().length > 0 &&
    isValidCronExpression(form.cronExpression) &&
    (!!fixedAgent || canReadAgents !== true || form.agentId.length > 0);
  const isPending =
    preparing || createSchedule.isPending || updateSchedule.isPending;

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isValid || submitting.current || disabledReason) return;
    submitting.current = true;
    setPreparing(true);
    setError(null);
    try {
      const agentFields = fixedAgent
        ? { agentId: fixedAgent.id }
        : canReadAgents === true && form.agentId
          ? { agentId: form.agentId }
          : {};
      const fields = {
        name: form.name.trim(),
        enabled,
        messageTemplate: form.messageTemplate.trim(),
        cronExpression: form.cronExpression.trim(),
        timezone: form.timezone.trim(),
        ...agentFields,
      };
      let result: ScheduleTrigger | null;
      if (schedule)
        result = await updateSchedule.mutateAsync({
          id: schedule.id,
          body: fields,
        });
      else {
        const targetProjectId = resolveProjectId
          ? await resolveProjectId()
          : projectId;
        if (!targetProjectId)
          throw new Error("Choose a project for this schedule.");
        result = await createSchedule.mutateAsync({
          ...fields,
          projectId: targetProjectId,
        });
      }
      if (!result)
        throw new Error("The schedule couldn’t be saved. Try again.");
      onSaved?.(result);
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The schedule couldn’t be saved. Try again.",
      );
    } finally {
      submitting.current = false;
      setPreparing(false);
    }
  };

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting.current) onOpenChange(next);
      }}
      title={title ?? (isEditing ? "Edit schedule" : "New schedule")}
      description={description}
      preventCloseOnEscape={isPending}
      preventCloseOnInteractOutside={isPending}
      size="medium"
      onSubmit={onSubmit}
      bodyClassName="space-y-3"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isPending || !isValid || !!disabledReason}
          >
            {isPending
              ? "Saving…"
              : (submitLabel ?? (isEditing ? "Save" : "Create"))}
          </Button>
        </>
      }
    >
      {(error || disabledReason) && (
        <InlineNotice variant="error">
          <InlineNoticeText>{disabledReason ?? error}</InlineNoticeText>
        </InlineNotice>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="schedule-name">
          Name <RequiredMark />
        </Label>
        <Input
          id="schedule-name"
          autoComplete="off"
          data-1p-ignore="true"
          aria-required
          value={form.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="Weekly summary"
          maxLength={256}
        />
      </div>

      {fixedAgent ? (
        <div className="space-y-1.5">
          <Label htmlFor="schedule-agent">Agent</Label>
          <Input
            id="schedule-agent"
            value={fixedAgent.name}
            readOnly
            autoComplete="off"
            data-1p-ignore="true"
          />
        </div>
      ) : (
        canReadAgents === true && (
          <div className="space-y-1.5">
            <Label>
              Agent <RequiredMark />
            </Label>
            <AgentSelector
              mode="single"
              flat
              remote={{
                filters: { agentType: "agent", onlyOwnPersonalAgents: true },
              }}
              value={form.agentId}
              onValueChange={(value) => update({ agentId: value })}
              placeholder="Select an agent"
              className="w-full"
            />
          </div>
        )
      )}

      <div className="space-y-1.5">
        <Label htmlFor="schedule-prompt">
          Task prompt <RequiredMark />
        </Label>
        <Textarea
          id="schedule-prompt"
          autoComplete="off"
          data-1p-ignore="true"
          aria-required
          value={form.messageTemplate}
          onChange={(e) => update({ messageTemplate: e.target.value })}
          placeholder="What should the agent do on each run?"
          rows={6}
        />
      </div>

      {projectField}

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

function RequiredMark() {
  return (
    <span className="text-destructive" aria-hidden="true">
      *
    </span>
  );
}

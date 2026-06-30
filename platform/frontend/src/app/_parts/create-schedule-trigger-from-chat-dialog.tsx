"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_FORM_STATE,
  isValidCronExpression,
  type ScheduleTriggerFormState,
} from "@/app/scheduled-tasks/schedule-trigger.utils";
import { AgentSelector } from "@/components/agent-selector";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  CronExpressionPicker,
  DEFAULT_CRON_PRESET_OPTIONS,
} from "@/components/ui/cron-expression-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TimezonePicker } from "@/components/ui/timezone-picker";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useCreateScheduleTrigger } from "@/lib/schedule-trigger.query";
import type { archestraApiTypes } from "@archestra/shared";

type Conversation = archestraApiTypes.GetChatConversationResponses["200"];

export function CreateScheduleTriggerFromChatDialog({
  conversationId,
  conversation,
  open,
  onOpenChange,
}: {
  conversationId: string | null;
  conversation: Conversation | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: agents = [] } = useProfiles({
    filters: { agentType: "agent" },
    enabled: canReadAgents === true,
  });
  const createSchedule = useCreateScheduleTrigger();

  const selectableAgents = useMemo(
    () =>
      agents.filter(
        (agent) =>
          agent.scope !== "personal" || agent.authorId === currentUserId,
      ),
    [agents, currentUserId],
  );

  const lastUserMessage = useMemo(() => {
    return [...((conversation?.messages as any) ?? [])]
      .reverse()
      .find((m: any) => m.role === "user");
  }, [conversation]);

  const defaultMessageTemplate = (lastUserMessage as any)?.content || "";
  const defaultName = conversation?.title
    ? `Schedule for ${conversation.title}`
    : "New schedule";
  const defaultAgentId =
    conversation?.agentId || conversation?.agent?.id || "";

  const [form, setForm] = useState<ScheduleTriggerFormState>(DEFAULT_FORM_STATE);

  useEffect(() => {
    if (open) {
      setForm({
        name: defaultName,
        agentId: defaultAgentId,
        cronExpression: "0 9 * * 1-5",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        messageTemplate: defaultMessageTemplate,
      });
    }
  }, [open, defaultName, defaultAgentId, defaultMessageTemplate]);

  const update = (patch: Partial<ScheduleTriggerFormState>) =>
    setForm((current) => ({ ...current, ...patch }));

  const isValid =
    form.name.trim().length > 0 &&
    form.messageTemplate.trim().length > 0 &&
    isValidCronExpression(form.cronExpression) &&
    (canReadAgents !== true || form.agentId.length > 0);
  const isPending = createSchedule.isPending;

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isValid || !conversationId) return;

    const agentFields =
      canReadAgents === true && form.agentId ? { agentId: form.agentId } : {};
    const fields = {
      name: form.name.trim(),
      messageTemplate: form.messageTemplate.trim(),
      cronExpression: form.cronExpression.trim(),
      timezone: form.timezone.trim(),
      ...agentFields,
    };

    const result = await createSchedule.mutateAsync({
      ...fields,
      projectId: conversation?.projectId || undefined,
    });
    if (result) {
      onOpenChange(false);
    }
  };

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Convert to scheduled task"
      description="Run an agent on a recurring schedule. Each run starts a chat in this project/workspace."
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

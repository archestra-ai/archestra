"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_SCHEDULE_TRIGGER_CRON_EXPRESSION } from "@/app/scheduled-tasks/schedule-trigger.utils";
import {
  type ScheduleTriggerAgentOption,
  ScheduleTriggerFormDialog,
} from "@/components/scheduled-tasks/schedule-trigger-form-dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useProfiles } from "@/lib/agent.query";
import {
  useConversationScheduleTriggerSuggestion,
  useCreateScheduleTriggerFromConversation,
} from "@/lib/schedule-trigger.query";

const REPLY_IN_SAME_HELP_TEXT =
  "Pick any agent that has already participated in this chat.";
const REPLY_IN_SAME_NO_HISTORY_TEXT =
  "This chat has no agent history yet, so replies can't be posted here. Send at least one message first.";

export function ConvertToScheduledTaskDialog({
  conversationId,
  open,
  onOpenChange,
}: {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { data: suggestion, isPending: suggestionPending } =
    useConversationScheduleTriggerSuggestion(open ? conversationId : null);
  const { data: agents = [], isLoading: agentsLoading } = useProfiles({
    enabled: open,
    filters: { agentType: "agent" },
  });
  const createMutation = useCreateScheduleTriggerFromConversation();

  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [cronExpression, setCronExpression] = useState(
    DEFAULT_SCHEDULE_TRIGGER_CRON_EXPRESSION,
  );
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [messageTemplate, setMessageTemplate] = useState("");
  const [replyInSameConversation, setReplyInSameConversation] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const createMutationResetRef = useRef(createMutation.reset);
  createMutationResetRef.current = createMutation.reset;
  const previousOpenRef = useRef(open);
  const previousConversationIdRef = useRef(conversationId);

  useEffect(() => {
    if (previousConversationIdRef.current !== conversationId) {
      previousConversationIdRef.current = conversationId;
      setHydrated(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (!open) {
      setHydrated(false);
      return;
    }
    if (hydrated || suggestionPending) return;
    if (suggestion) {
      setName(suggestion.suggestedName ?? "");
      if (suggestion.suggestedAgentId) {
        setAgentId(suggestion.suggestedAgentId);
      }
      setMessageTemplate(
        suggestion.suggestedMessageTemplate ??
          suggestion.suggestedMessageTemplatePreview ??
          "",
      );
    }
    setHydrated(true);
  }, [open, suggestion, suggestionPending, hydrated]);

  const linkedAllowedAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const candidate of suggestion?.candidates ?? []) {
      ids.add(candidate.agent.id);
    }
    if (suggestion?.suggestedAgentId) {
      ids.add(suggestion.suggestedAgentId);
    }
    return ids;
  }, [suggestion?.candidates, suggestion?.suggestedAgentId]);

  useEffect(() => {
    if (!replyInSameConversation || linkedAllowedAgentIds.size === 0) return;
    if (agentId && linkedAllowedAgentIds.has(agentId)) return;
    const fallback =
      suggestion?.suggestedAgentId ?? suggestion?.candidates[0]?.agent.id ?? "";
    if (fallback) {
      setAgentId(fallback);
    }
  }, [
    replyInSameConversation,
    linkedAllowedAgentIds,
    agentId,
    suggestion?.suggestedAgentId,
    suggestion?.candidates,
  ]);

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;

    if (!wasOpen || open) return;

    setName("");
    setAgentId("");
    setCronExpression(DEFAULT_SCHEDULE_TRIGGER_CRON_EXPRESSION);
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setMessageTemplate("");
    setReplyInSameConversation(false);
    createMutationResetRef.current();
  }, [open]);

  const trimmedName = name.trim();
  const trimmedTimezone = timezone.trim();
  const trimmedTemplate = messageTemplate.trim();
  const summaryReady = hydrated && !suggestionPending;
  const isFormValid =
    !!trimmedName &&
    !!agentId &&
    !!cronExpression.trim() &&
    !!trimmedTimezone &&
    summaryReady &&
    trimmedTemplate.length > 0;

  const linkedAgentOptions = useMemo<ScheduleTriggerAgentOption[]>(() => {
    const seen = new Set<string>();
    const options: ScheduleTriggerAgentOption[] = [];

    for (const candidate of suggestion?.candidates ?? []) {
      if (seen.has(candidate.agent.id)) continue;
      seen.add(candidate.agent.id);
      const agentDetails = agents.find((a) => a.id === candidate.agent.id);
      options.push({
        value: candidate.agent.id,
        label: candidate.agent.name || "Untitled agent",
        description: agentDetails?.description ?? undefined,
      });
    }

    if (
      suggestion?.suggestedAgentId &&
      !seen.has(suggestion.suggestedAgentId)
    ) {
      const fallback = agents.find((a) => a.id === suggestion.suggestedAgentId);
      if (fallback) {
        options.unshift({
          value: fallback.id,
          label: fallback.name || "Untitled agent",
          description: fallback.description ?? undefined,
        });
      }
    }

    return options;
  }, [suggestion?.candidates, suggestion?.suggestedAgentId, agents]);

  const fullAgentOptions = useMemo<ScheduleTriggerAgentOption[]>(
    () =>
      agents.map((agent) => ({
        value: agent.id,
        label: agent.name || "Untitled agent",
        description: agent.description ?? undefined,
      })),
    [agents],
  );

  const agentOptions = replyInSameConversation
    ? linkedAgentOptions
    : fullAgentOptions;
  const hasAgents = agentOptions.length > 0;
  const linkedSelectorDisabled =
    replyInSameConversation && linkedAgentOptions.length === 0;

  const values = useMemo(
    () => ({
      name,
      agentId,
      cronExpression,
      timezone,
      messageTemplate,
    }),
    [name, agentId, cronExpression, timezone, messageTemplate],
  );

  const handleSubmit = async () => {
    if (!isFormValid) return;

    const created = await createMutation.mutateAsync({
      conversationId,
      name: trimmedName,
      agentId,
      cronExpression: cronExpression.trim(),
      timezone: trimmedTimezone,
      messageTemplate: trimmedTemplate,
      ...(replyInSameConversation ? { replyInSameConversation: true } : {}),
    });

    if (created) {
      onOpenChange(false);
      router.push(`/scheduled-tasks?triggerId=${created.id}`);
    }
  };

  return (
    <ScheduleTriggerFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Convert to scheduled task"
      values={values}
      agentOptions={agentOptions}
      agentsLoading={agentsLoading}
      hasAgents={hasAgents}
      isSaving={createMutation.isPending}
      isFormValid={isFormValid}
      permissions={{ scheduledTask: ["create"] }}
      submitLabel="Create scheduled task"
      onSubmit={() => {
        void handleSubmit();
      }}
      onNameChange={setName}
      onAgentChange={setAgentId}
      onCronExpressionChange={setCronExpression}
      onMessageTemplateChange={setMessageTemplate}
      showTimezone={false}
      showEnabled={false}
      agentSelectDisabled={linkedSelectorDisabled}
      agentSelectHelpText={
        replyInSameConversation
          ? linkedSelectorDisabled
            ? REPLY_IN_SAME_NO_HISTORY_TEXT
            : REPLY_IN_SAME_HELP_TEXT
          : undefined
      }
      promptLabel="Summary"
      promptDescription="Generated from this conversation. Edit before saving if needed."
      promptLoading={open && suggestionPending}
      promptPlaceholder="Write the prompt to send on each scheduled run."
      postEnabledSection={
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label htmlFor="dialog-reply-in-same-conversation">
              Post scheduled replies in this conversation
            </Label>
            <p className="text-xs text-muted-foreground">
              Replies will be posted to this chat.
            </p>
          </div>
          <Switch
            id="dialog-reply-in-same-conversation"
            checked={replyInSameConversation}
            onCheckedChange={setReplyInSameConversation}
          />
        </div>
      }
    />
  );
}

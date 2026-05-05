import type { UseMutationResult } from "@tanstack/react-query";
import type {
  ScheduleTriggerReplyChannel,
  ScheduleTriggerRunStatus,
} from "@/lib/schedule-trigger.query";

export type AgentOption = {
  value: string;
  label: string;
  description: string;
};

export const DEFAULT_SCHEDULE_TRIGGER_CRON_EXPRESSION = "0 9 * * 1,2,3,4,5";

export type ScheduleTriggerFormState = {
  name: string;
  agentId: string;
  cronExpression: string;
  timezone: string;
  messageTemplate: string;
  keepResultsInSameChat: boolean;
  replyChannel: ScheduleTriggerReplyChannel;
};

export const DEFAULT_FORM_STATE = (): ScheduleTriggerFormState => ({
  name: "",
  agentId: "",
  cronExpression: DEFAULT_SCHEDULE_TRIGGER_CRON_EXPRESSION,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  messageTemplate: "",
  keepResultsInSameChat: false,
  replyChannel: "chat",
});

export function buildScheduleTriggerPayload(
  formState: ScheduleTriggerFormState,
) {
  const payload = {
    name: formState.name.trim(),
    agentId: formState.agentId,
    cronExpression: formState.cronExpression.trim(),
    timezone: formState.timezone.trim(),
    messageTemplate: formState.messageTemplate.trim(),
    keepResultsInSameChat: formState.keepResultsInSameChat,
    replyChannel: formState.replyChannel,
  };

  if (
    !payload.name ||
    !payload.agentId ||
    !payload.cronExpression ||
    !payload.timezone ||
    !payload.messageTemplate
  ) {
    return null;
  }

  return payload;
}

export function getActiveMutationVariable<T>(
  mutation: Pick<
    UseMutationResult<unknown, unknown, T, unknown>,
    "isPending" | "variables"
  >,
): T | null {
  return mutation.isPending ? (mutation.variables ?? null) : null;
}

export function isScheduleTriggerRunActive(
  status: ScheduleTriggerRunStatus | null | undefined,
): boolean {
  return status === "running";
}

export function getRunNowTrackingState(params: {
  activeMutationTriggerId: string | null;
  currentTriggerId: string;
  trackedRunId: string | null;
  trackedRunStatus?: ScheduleTriggerRunStatus | null;
}): {
  isButtonSpinning: boolean;
  shouldPollRuns: boolean;
  shouldClearTrackedRun: boolean;
} {
  const isMutationPending =
    params.activeMutationTriggerId === params.currentTriggerId;

  if (!params.trackedRunId) {
    return {
      isButtonSpinning: isMutationPending,
      shouldPollRuns: false,
      shouldClearTrackedRun: false,
    };
  }

  if (params.trackedRunStatus === undefined) {
    return {
      isButtonSpinning: true,
      shouldPollRuns: true,
      shouldClearTrackedRun: false,
    };
  }

  const isTrackedRunActive = isScheduleTriggerRunActive(
    params.trackedRunStatus,
  );

  return {
    isButtonSpinning: isMutationPending || isTrackedRunActive,
    shouldPollRuns: isTrackedRunActive,
    shouldClearTrackedRun: !isTrackedRunActive,
  };
}

export function getScheduleTriggerRunSessionId(runId: string): string {
  return `scheduled-${runId}`;
}

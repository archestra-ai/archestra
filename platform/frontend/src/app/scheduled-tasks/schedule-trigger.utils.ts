import type { UseMutationResult } from "@tanstack/react-query";
import type {
  ScheduleTrigger,
  ScheduleTriggerRunStatus,
} from "@/lib/schedule-trigger.query";

export type AgentOption = {
  value: string;
  label: string;
  description: string;
};

export type ScheduleTriggerFormState = {
  name: string;
  agentId: string;
  cronExpression: string;
  timezone: string;
  messageTemplate: string;
};

export const DEFAULT_FORM_STATE = (): ScheduleTriggerFormState => ({
  name: "",
  agentId: "",
  cronExpression: "0 9 * * 1-5",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  messageTemplate: "",
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

export function deriveScheduleTriggerName(
  formState: ScheduleTriggerFormState,
  agentLabel?: string | null,
) {
  const prompt = formState.messageTemplate.trim().replace(/\s+/g, " ");
  if (prompt) {
    return prompt.length > 52 ? `${prompt.slice(0, 49).trimEnd()}...` : prompt;
  }

  const fallback = agentLabel?.trim() || "Scheduled run";
  return fallback.length > 52
    ? `${fallback.slice(0, 49).trimEnd()}...`
    : fallback;
}

export function partitionScheduleTriggers(triggers: ScheduleTrigger[]) {
  return {
    enabledTriggers: triggers.filter((trigger) => trigger.enabled),
    disabledTriggers: triggers.filter((trigger) => !trigger.enabled),
  };
}

export function buildTimezoneOptions(timezone: string): AgentOption[] {
  const browserTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const currentValue = timezone.trim() || browserTimezone;
  const supportedTimezones = getSupportedTimezones();
  const prioritizedValues = [
    browserTimezone,
    "UTC",
    currentValue,
    ...supportedTimezones,
  ];

  return prioritizedValues.reduce<AgentOption[]>((options, value) => {
    if (!value || options.some((option) => option.value === value)) {
      return options;
    }

    options.push({
      value,
      label: value,
      description:
        value === browserTimezone
          ? "Current browser timezone"
          : value === "UTC"
            ? "Coordinated Universal Time"
            : value === currentValue && currentValue !== browserTimezone
              ? "Current value"
              : "IANA timezone",
    });

    return options;
  }, []);
}

function getSupportedTimezones(): string[] {
  if (typeof Intl.supportedValuesOf === "function") {
    return Intl.supportedValuesOf("timeZone");
  }

  return [
    "UTC",
    "Africa/Johannesburg",
    "America/Chicago",
    "America/Los_Angeles",
    "America/New_York",
    "Asia/Dubai",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Sydney",
    "Europe/London",
    "Europe/Oslo",
  ];
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

export function getTimezonePreview(timezone: string): string | null {
  const normalized = timezone.trim();
  if (!normalized) {
    return null;
  }

  try {
    return `Current time there: ${new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: normalized,
    }).format(new Date())}`;
  } catch {
    return "Timezone must be a valid IANA value such as UTC or America/New_York.";
  }
}

export function getScheduleTriggerRunSessionId(runId: string): string {
  return `scheduled-${runId}`;
}

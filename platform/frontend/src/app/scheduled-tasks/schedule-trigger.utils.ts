import type { UseMutationResult } from "@tanstack/react-query";
import { Cron } from "croner";
import type { ScheduleTriggerRunStatus } from "@/lib/schedule-trigger.query";

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

export type ScheduleMode = "hourly" | "daily" | "custom";

const DEFAULT_DAILY_SCHEDULE = {
  hour: "9",
  minute: "0",
  days: [1, 2, 3, 4, 5],
};

/**
 * Maps a cron expression onto the Schedule section's UI state. Expressions that
 * fit the simple "hourly" or "daily" presets open in those tabs; anything else
 * (steps, day-of-month, named fields, 6-part, …) opens in the "custom" tab so it
 * round-trips untouched instead of being silently rewritten by a preset.
 */
export function parseCronToMode(cron: string): {
  mode: ScheduleMode;
  hour: string;
  minute: string;
  days: number[];
} {
  const parts = cron.trim().split(/\s+/);

  if (parts.length !== 5) {
    return { mode: "custom", ...DEFAULT_DAILY_SCHEDULE };
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const isPlainInt = (value: string) => /^\d+$/.test(value);

  // Hourly preset: fixed minute, every hour/day/month/weekday -> "0 * * * *".
  if (
    isPlainInt(minute) &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return { mode: "hourly", ...DEFAULT_DAILY_SCHEDULE };
  }

  // Daily preset: fixed minute+hour, every day/month, simple weekday pattern.
  if (
    isPlainInt(minute) &&
    isPlainInt(hour) &&
    dayOfMonth === "*" &&
    month === "*"
  ) {
    const days = parseDayOfWeekField(dayOfWeek);
    if (days && days.length > 0) {
      return { mode: "daily", hour, minute, days };
    }
  }

  return { mode: "custom", ...DEFAULT_DAILY_SCHEDULE };
}

export function buildCronFromSchedule(
  mode: Exclude<ScheduleMode, "custom">,
  hour: string,
  minute: string,
  days: number[],
): string {
  switch (mode) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily": {
      const sorted = [...days].sort((a, b) => a - b);
      const dayOfWeek =
        sorted.length === 7 || sorted.length === 0 ? "*" : sorted.join(",");
      return `${minute} ${hour} * * ${dayOfWeek}`;
    }
  }
}

/**
 * Validates a cron expression the same way the backend does: croner in 5-part
 * mode. Used to gate form submission and surface inline errors in the custom tab.
 */
export function isValidCronExpression(expression: string): boolean {
  const trimmed = expression.trim();
  if (!trimmed) {
    return false;
  }
  try {
    new Cron(trimmed, { mode: "5-part" });
    return true;
  } catch {
    return false;
  }
}

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
    !payload.messageTemplate ||
    !isValidCronExpression(payload.cronExpression)
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

/**
 * Parses a cron day-of-week field into weekday numbers (0-6), supporting only
 * simple values, comma lists, and ascending ranges. Returns null for anything
 * else (steps, names, …) so the caller routes the expression to the custom tab.
 */
function parseDayOfWeekField(dayOfWeek: string): number[] | null {
  if (dayOfWeek === "*") {
    return [0, 1, 2, 3, 4, 5, 6];
  }

  const days: number[] = [];
  for (const part of dayOfWeek.split(",")) {
    if (/^[0-6]$/.test(part)) {
      days.push(Number(part));
    } else if (/^[0-6]-[0-6]$/.test(part)) {
      const [start, end] = part.split("-").map(Number);
      if (start > end) {
        return null;
      }
      for (let day = start; day <= end; day++) {
        days.push(day);
      }
    } else {
      return null;
    }
  }
  return days;
}

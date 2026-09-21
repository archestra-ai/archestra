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

export type ScheduleFrequency =
  | "manual"
  | "hourly"
  | "6h"
  | "12h"
  | "daily"
  | "weekly"
  | "custom";

const DEFAULT_DAILY_SCHEDULE = {
  hour: "9",
  minute: "0",
  days: [0, 1, 2, 3, 4, 5, 6],
};

/**
 * Maps a cron expression onto the legacy ScheduleMode state used by the
 * structured picker. It recognizes only hourly and daily shapes; callers that
 * need manual, 6-hour, 12-hour, or weekly classification should use
 * parseScheduleFrequency. Unsupported syntax returns custom state so it
 * round-trips untouched instead of being silently rewritten.
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
    return {
      mode: "hourly",
      hour: DEFAULT_DAILY_SCHEDULE.hour,
      minute,
      days: DEFAULT_DAILY_SCHEDULE.days,
    };
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

export function parseScheduleFrequency(
  cron: string,
  enabled: boolean,
): ScheduleFrequency {
  if (!enabled) {
    return "manual";
  }

  const normalizedCron = normalizeCronExpression(cron);
  if (normalizedCron === "0 */6 * * *") {
    return "6h";
  }
  if (normalizedCron === "0 */12 * * *") {
    return "12h";
  }

  const parsed = parseCronToMode(normalizedCron);
  if (parsed.mode === "hourly") {
    return "hourly";
  }
  if (parsed.mode === "daily") {
    return parsed.days.length === 1 ? "weekly" : "daily";
  }
  return "custom";
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
      const dayOfWeek = compressDayOfWeek(sorted);
      return `${minute} ${hour} * * ${dayOfWeek}`;
    }
  }
}

export function buildScheduleCron(
  frequency: ScheduleFrequency,
  hour: string,
  minute: string,
  days: number[],
): string | null {
  switch (frequency) {
    case "manual":
    case "custom":
      return null;
    case "hourly":
      return buildCronFromSchedule("hourly", hour, minute, days);
    case "6h":
      return "0 */6 * * *";
    case "12h":
      return "0 */12 * * *";
    case "daily":
      return buildCronFromSchedule("daily", hour, minute, days);
    case "weekly": {
      const day = days[0];
      return day === undefined
        ? null
        : buildCronFromSchedule("daily", hour, minute, [day]);
    }
  }
}

/**
 * Validates a cron expression the same way the backend does: croner in 5-part
 * mode. Used to gate form submission and surface inline errors in the custom
 * frequency.
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

/**
 * Decides how the chat pane should present a conversation that backs a scheduled
 * run. Live output uses chat replay with the normal composer and Stop control.
 * `context` is the schedule context read
 * from the chat URL (null for an ordinary chat); `runStatus` is the pinned run's
 * status (undefined until it loads).
 */
export function getScheduledRunChatState(params: {
  context: { triggerId: string; runId: string | null } | null;
  runStatus: ScheduleTriggerRunStatus | null | undefined;
}): { isScheduledRunChat: boolean; isRunInProgress: boolean } {
  const isScheduledRunChat = params.context !== null;
  const isRunInProgress =
    isScheduledRunChat &&
    params.context?.runId != null &&
    isScheduleTriggerRunActive(params.runStatus);
  return { isScheduledRunChat, isRunInProgress };
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

function normalizeCronExpression(cron: string): string {
  return cron.trim().split(/\s+/).join(" ");
}

function compressDayOfWeek(days: number[]): string {
  const uniqueDays = [...new Set(days)];
  if (uniqueDays.length === 7 || uniqueDays.length === 0) {
    return "*";
  }

  const sorted = uniqueDays.sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let end = sorted[0];

  const appendRun = () => {
    if (start === undefined || end === undefined) {
      return;
    }
    if (end - start >= 2) {
      parts.push(`${start}-${end}`);
      return;
    }
    for (let day = start; day <= end; day++) {
      parts.push(String(day));
    }
  };

  for (const day of sorted.slice(1)) {
    if (day === end + 1) {
      end = day;
      continue;
    }
    appendRun();
    start = day;
    end = day;
  }
  appendRun();

  return parts.join(",");
}

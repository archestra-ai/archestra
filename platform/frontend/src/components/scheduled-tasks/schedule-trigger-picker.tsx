"use client";

import { Cron } from "croner";
import { Clock3 } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  buildScheduleCron,
  isValidCronExpression,
  parseCronToMode,
  parseScheduleFrequency,
  type ScheduleFrequency,
} from "@/components/scheduled-tasks/schedule-trigger.utils";
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
import { TimezonePicker } from "@/components/ui/timezone-picker";
import { Toggle } from "@/components/ui/toggle";
import { formatCronSchedule } from "@/lib/utils/format-cron";
import { cn } from "@/lib/utils/tailwind";

export type ScheduleTriggerPickerValue = {
  enabled: boolean;
  cronExpression: string;
  timezone: string;
};

type ScheduleTriggerPickerProps = {
  value: ScheduleTriggerPickerValue;
  onChange: (value: ScheduleTriggerPickerValue) => void;
};

type DayOption = {
  value: number;
  label: string;
  fullLabel: string;
};

const FREQUENCY_OPTIONS: Array<{ value: ScheduleFrequency; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "hourly", label: "Every hour" },
  { value: "6h", label: "Every 6 hours" },
  { value: "12h", label: "Every 12 hours" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom cron" },
];

const DAY_OPTIONS: DayOption[] = [
  { value: 1, label: "Mon", fullLabel: "Monday" },
  { value: 2, label: "Tue", fullLabel: "Tuesday" },
  { value: 3, label: "Wed", fullLabel: "Wednesday" },
  { value: 4, label: "Thu", fullLabel: "Thursday" },
  { value: 5, label: "Fri", fullLabel: "Friday" },
  { value: 6, label: "Sat", fullLabel: "Saturday" },
  { value: 0, label: "Sun", fullLabel: "Sunday" },
];

const DEFAULT_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const DEFAULT_WEEKLY_DAY = 1;

export function ScheduleTriggerPicker({
  value,
  onChange,
}: ScheduleTriggerPickerProps) {
  const initialState = getInitialState(value);
  const [frequency, setFrequency] = useState(initialState.frequency);
  const [hour, setHour] = useState(initialState.hour);
  const [minute, setMinute] = useState(initialState.minute);
  const [days, setDays] = useState(initialState.days);
  const [weeklyDay, setWeeklyDay] = useState(initialState.weeklyDay);
  const [customDraft, setCustomDraft] = useState(initialState.customDraft);

  const structuredCron = buildStructuredCron({
    frequency,
    hour,
    minute,
    days,
    weeklyDay,
  });
  const currentCron =
    frequency === "custom" ? normalizeCron(customDraft) : structuredCron;
  const customIsValid =
    frequency === "custom" && isValidCronExpression(customDraft);
  const summaryIsValid =
    frequency !== "manual" && (frequency !== "custom" || customIsValid);

  const emit = (next: { enabled: boolean; cronExpression: string }) => {
    onChange({ ...next, timezone: value.timezone });
  };

  const emitStructured = (
    nextFrequency: Exclude<ScheduleFrequency, "manual" | "custom">,
    nextHour = hour,
    nextMinute = minute,
    nextDays = days,
    nextWeeklyDay = weeklyDay,
  ) => {
    emit({
      enabled: true,
      cronExpression:
        buildScheduleCron(
          nextFrequency,
          nextHour,
          nextMinute,
          nextFrequency === "weekly" ? [nextWeeklyDay] : nextDays,
        ) ?? "",
    });
  };

  const handleFrequencyChange = (nextFrequency: ScheduleFrequency) => {
    if (nextFrequency === "manual") {
      setFrequency(nextFrequency);
      emit({ enabled: false, cronExpression: value.cronExpression });
      return;
    }

    if (nextFrequency === "custom") {
      const seed =
        frequency === "custom"
          ? customDraft
          : frequency === "manual"
            ? value.cronExpression
            : structuredCron;
      setCustomDraft(normalizeCron(seed));
      setFrequency(nextFrequency);
      emit({ enabled: true, cronExpression: normalizeCron(seed) });
      return;
    }

    setFrequency(nextFrequency);
    emitStructured(nextFrequency);
  };

  const handleTimeChange = (nextTime: string) => {
    const match = /^(\d{2}):(\d{2})$/.exec(nextTime);
    if (!match) return;
    const nextHour = String(Number(match[1]));
    const nextMinute = String(Number(match[2]));
    setHour(nextHour);
    setMinute(nextMinute);
    if (frequency !== "manual" && frequency !== "custom") {
      emitStructured(frequency, nextHour, nextMinute);
    }
  };

  const handleDayToggle = (day: number, pressed: boolean) => {
    if (!pressed && days.length <= 1) return;
    const nextDays = [
      ...days.filter((value) => value !== day),
      ...(pressed ? [day] : []),
    ].sort((a, b) => a - b);
    setDays(nextDays);
    emitStructured("daily", hour, minute, nextDays);
  };

  const handleCustomChange = (nextDraft: string) => {
    setCustomDraft(nextDraft);
    emit({ enabled: true, cronExpression: normalizeCron(nextDraft) });
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="schedule-frequency">Schedule</Label>
      <Select value={frequency} onValueChange={handleFrequencyChange}>
        <SelectTrigger id="schedule-frequency" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FREQUENCY_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {frequency === "manual" && (
        <p className="text-xs text-muted-foreground">
          <span>Only runs when you choose Run manually.</span>
        </p>
      )}

      {frequency === "hourly" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">Timezone</span>
          <TimezonePicker
            value={value.timezone}
            onValueChange={(timezone) => onChange({ ...value, timezone })}
            ariaLabel="Timezone"
            className="min-w-[200px] flex-1"
          />
        </div>
      )}

      {(frequency === "6h" || frequency === "12h") && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">Timezone</span>
          <TimezonePicker
            value={value.timezone}
            onValueChange={(timezone) => onChange({ ...value, timezone })}
            ariaLabel="Timezone"
            className="min-w-[200px] flex-1"
          />
        </div>
      )}

      {frequency === "daily" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">At</span>
            <Input
              type="time"
              aria-label="Time"
              value={formatTime(hour, minute)}
              onChange={(event) => handleTimeChange(event.target.value)}
              className="w-auto"
            />
            <span className="text-sm">in</span>
            <TimezonePicker
              value={value.timezone}
              onValueChange={(timezone) => onChange({ ...value, timezone })}
              ariaLabel="Timezone"
              className="min-w-[200px] flex-1"
            />
          </div>
          <div className="space-y-2">
            <fieldset
              aria-label="Days of week"
              className="flex flex-wrap gap-1.5"
            >
              {DAY_OPTIONS.map((day) => (
                <Toggle
                  key={day.value}
                  type="button"
                  variant="outline"
                  aria-label={day.fullLabel}
                  pressed={days.includes(day.value)}
                  onPressedChange={(pressed) =>
                    handleDayToggle(day.value, pressed)
                  }
                  className="data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  {day.label}
                </Toggle>
              ))}
            </fieldset>
            <div className="flex gap-1">
              <ButtonLink onClick={() => handleDayShortcut(WEEKDAYS)}>
                Weekdays
              </ButtonLink>
              <ButtonLink
                onClick={() => handleDayShortcut([0, 1, 2, 3, 4, 5, 6])}
              >
                Every day
              </ButtonLink>
            </div>
          </div>
        </>
      )}

      {frequency === "weekly" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">On</span>
          <Select
            value={String(weeklyDay)}
            onValueChange={(nextDay) => {
              const nextWeeklyDay = Number(nextDay);
              setWeeklyDay(nextWeeklyDay);
              emitStructured("weekly", hour, minute, days, nextWeeklyDay);
            }}
          >
            <SelectTrigger aria-label="Day" className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAY_OPTIONS.map((day) => (
                <SelectItem key={day.value} value={String(day.value)}>
                  {day.fullLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-sm">at</span>
          <Input
            type="time"
            aria-label="Time"
            value={formatTime(hour, minute)}
            onChange={(event) => handleTimeChange(event.target.value)}
            className="w-auto"
          />
          <span className="text-sm">in</span>
          <TimezonePicker
            value={value.timezone}
            onValueChange={(timezone) => onChange({ ...value, timezone })}
            ariaLabel="Timezone"
            className="min-w-[200px] flex-1"
          />
        </div>
      )}

      {frequency === "custom" && (
        <>
          <Input
            value={customDraft}
            onChange={(event) => handleCustomChange(event.target.value)}
            aria-label="Custom cron expression"
            aria-invalid={!customIsValid}
            aria-describedby={
              customIsValid ? "schedule-custom-hint" : "schedule-custom-error"
            }
            className="font-mono"
          />
          <p
            id={
              customIsValid ? "schedule-custom-hint" : "schedule-custom-error"
            }
            className={cn(
              "text-xs",
              customIsValid ? "text-muted-foreground" : "text-destructive",
            )}
          >
            {customIsValid ? (
              <span>
                Five fields: minute, hour, day of month, month, day of week.
              </span>
            ) : customDraft.trim() ? (
              <span>
                This is not a valid cron expression. Expected five fields:
                minute, hour, day of month, month, day of week.
              </span>
            ) : (
              <span>Enter a cron expression.</span>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Timezone</span>
            <TimezonePicker
              value={value.timezone}
              onValueChange={(timezone) => onChange({ ...value, timezone })}
              ariaLabel="Timezone"
              className="min-w-[200px] flex-1"
            />
          </div>
        </>
      )}

      {summaryIsValid && (
        <ScheduleSummary
          expression={currentCron}
          timezone={value.timezone}
          showExpression={frequency !== "custom"}
        />
      )}
    </div>
  );

  function handleDayShortcut(nextDays: number[]) {
    setDays(nextDays);
    emitStructured("daily", hour, minute, nextDays);
  }
}

function ButtonLink({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button type="button" variant="link" size="sm" onClick={onClick}>
      {children}
    </Button>
  );
}

function ScheduleSummary({
  expression,
  timezone,
  showExpression,
}: {
  expression: string;
  timezone: string;
  showExpression: boolean;
}) {
  const nextRun = getNextRunLabel(expression, timezone);
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm">
      <Clock3
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p>{formatCronSchedule(expression)}</p>
        <p className="text-xs text-muted-foreground">
          {nextRun ? (
            <span>Next run {nextRun}</span>
          ) : (
            <span>No upcoming run.</span>
          )}
        </p>
      </div>
      {showExpression && (
        <code className="shrink-0 font-mono text-xs text-muted-foreground">
          {expression}
        </code>
      )}
    </div>
  );
}

function getInitialState(value: ScheduleTriggerPickerValue) {
  const parsed = parseCronToMode(value.cronExpression);
  const frequency = parseScheduleFrequency(value.cronExpression, value.enabled);
  const days =
    value.enabled && parsed.mode === "daily" ? parsed.days : DEFAULT_DAYS;
  const hour =
    value.enabled && (parsed.mode === "daily" || parsed.mode === "hourly")
      ? parsed.hour
      : "0";
  const minute =
    value.enabled && (parsed.mode === "daily" || parsed.mode === "hourly")
      ? parsed.minute
      : "0";
  return {
    frequency,
    hour,
    minute,
    days: days.length > 0 ? days : DEFAULT_DAYS,
    weeklyDay:
      days.length === 1
        ? days[0]
        : days.includes(DEFAULT_WEEKLY_DAY)
          ? DEFAULT_WEEKLY_DAY
          : (days[0] ?? DEFAULT_WEEKLY_DAY),
    customDraft: value.cronExpression.trim(),
  };
}

function buildStructuredCron({
  frequency,
  hour,
  minute,
  days,
  weeklyDay,
}: {
  frequency: ScheduleFrequency;
  hour: string;
  minute: string;
  days: number[];
  weeklyDay: number;
}) {
  if (frequency === "manual" || frequency === "custom") return "";
  return (
    buildScheduleCron(
      frequency,
      hour,
      minute,
      frequency === "weekly" ? [weeklyDay] : days,
    ) ?? ""
  );
}

function formatTime(hour: string, minute: string): string {
  if (!/^\d+$/.test(hour) || !/^\d+$/.test(minute)) return "";
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function normalizeCron(expression: string): string {
  return expression.trim().replace(/\s+/g, " ");
}

function getNextRunLabel(expression: string, timezone: string): string | null {
  try {
    const nextRun = new Cron(expression, {
      mode: "5-part",
      paused: true,
      timezone,
    }).nextRun();
    if (!nextRun) return null;

    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(nextRun).map((part) => [part.type, part.value]),
    );
    const label = getRelativeDayLabel(new Date(), nextRun, timezone);
    return `${label} at ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
  } catch {
    return null;
  }
}

function getRelativeDayLabel(
  now: Date,
  nextRun: Date,
  timezone: string,
): string {
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const getDayKey = (date: Date) => {
    const parts = Object.fromEntries(
      dateFormatter.formatToParts(date).map((part) => [part.type, part.value]),
    );
    return Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
    );
  };
  const dayDifference =
    (getDayKey(nextRun) - getDayKey(now)) / (24 * 60 * 60 * 1000);
  if (dayDifference === 0) return "today";
  if (dayDifference === 1) return "tomorrow";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(nextRun);
}

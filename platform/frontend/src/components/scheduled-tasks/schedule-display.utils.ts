import { Cron } from "croner";
import type { ScheduleTrigger } from "@/lib/schedule-trigger.query";

export function nextScheduleDate(schedule: ScheduleTrigger, now = new Date()) {
  if (!schedule.enabled) return null;
  try {
    return new Cron(schedule.cronExpression, {
      timezone: schedule.timezone,
    }).nextRun(now);
  } catch {
    return null;
  }
}

export function scheduleDateTime(date: Date | string, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

export function nextScheduleTime(schedule: ScheduleTrigger) {
  if (!schedule.enabled) return "Paused";
  const next = nextScheduleDate(schedule);
  return next ? scheduleDateTime(next, schedule.timezone) : "Unavailable";
}

export function scheduleTimezone(timezone: string, at: Date = new Date()) {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? timezone
  );
}

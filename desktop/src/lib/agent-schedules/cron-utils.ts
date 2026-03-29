/**
 * Cron / interval utilities for agent schedule triggers.
 */

import type { CronTrigger, IntervalTrigger, ScheduleTrigger } from "./types";

const CRON_FIELD_COUNT = 5;

/**
 * Very lightweight cron-expression validator.
 * Accepts the standard 5-field "minute hour dom month dow" format.
 */
export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) return false;

  const ranges: [number, number][] = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // dom
    [1, 12], // month
    [0, 7],  // dow (0 and 7 are both Sunday)
  ];

  return fields.every((field, i) => isValidCronField(field, ranges[i]));
}

function isValidCronField(field: string, [min, max]: [number, number]): boolean {
  if (field === "*") return true;

  // Step values: */5 or 1-5/2
  if (field.includes("/")) {
    const [range, step] = field.split("/");
    const stepNum = parseInt(step, 10);
    if (isNaN(stepNum) || stepNum < 1) return false;
    return range === "*" || isValidCronRange(range, min, max);
  }

  // Lists: 1,2,3
  if (field.includes(",")) {
    return field.split(",").every((part) => isValidCronValue(part, min, max));
  }

  // Ranges: 1-5
  if (field.includes("-")) {
    return isValidCronRange(field, min, max);
  }

  return isValidCronValue(field, min, max);
}

function isValidCronRange(range: string, min: number, max: number): boolean {
  const [start, end] = range.split("-").map(Number);
  return (
    !isNaN(start) &&
    !isNaN(end) &&
    start >= min &&
    end <= max &&
    start <= end
  );
}

function isValidCronValue(value: string, min: number, max: number): boolean {
  const num = parseInt(value, 10);
  return !isNaN(num) && num >= min && num <= max;
}

/**
 * Convert an IntervalTrigger to milliseconds.
 */
export function intervalToMs(trigger: IntervalTrigger): number {
  const { value, unit } = trigger;
  switch (unit) {
    case "minutes":
      return value * 60_000;
    case "hours":
      return value * 3_600_000;
    case "days":
      return value * 86_400_000;
  }
}

/**
 * Calculate the next execution date for a schedule trigger relative to `from`.
 *
 * For interval triggers this is simply `from + intervalMs`.
 * For cron triggers we use a simplified next-tick algorithm.
 */
export function getNextRunDate(trigger: ScheduleTrigger, from: Date = new Date()): Date {
  if (trigger.type === "interval") {
    return new Date(from.getTime() + intervalToMs(trigger));
  }
  return getNextCronDate(trigger, from);
}

/**
 * Human-readable description of a schedule trigger.
 */
export function describeTrigger(trigger: ScheduleTrigger): string {
  if (trigger.type === "interval") {
    return `Every ${trigger.value} ${trigger.unit}`;
  }
  return `Cron: ${trigger.expression}${trigger.timezone ? ` (${trigger.timezone})` : ""}`;
}

// ---------------------------------------------------------------------------
// Minimal cron "next run" calculator
// ---------------------------------------------------------------------------

/**
 * Find the next date that satisfies a 5-field cron expression.
 * This handles the vast majority of real-world cron schedules.
 */
function getNextCronDate(trigger: CronTrigger, from: Date): Date {
  const tz = trigger.timezone ?? "UTC";
  const expr = trigger.expression.trim().split(/\s+/);
  const [minField, hourField, domField, monField, dowField] = expr;

  // Start one minute after `from`
  const candidate = new Date(from.getTime() + 60_000);
  candidate.setSeconds(0, 0);

  // Search up to 4 years out to avoid infinite loops on bad expressions
  const limit = new Date(from.getTime() + 4 * 365 * 24 * 3_600_000);

  while (candidate < limit) {
    const parts = getDateParts(candidate, tz);

    if (!matchesCronField(monField, parts.month, 1, 12)) {
      // Advance to the 1st of the next month
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    if (
      !matchesCronField(domField, parts.dom, 1, 31) ||
      !matchesCronField(dowField, parts.dow, 0, 7)
    ) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    if (!matchesCronField(hourField, parts.hour, 0, 23)) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!matchesCronField(minField, parts.minute, 0, 59)) {
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }

    return candidate;
  }

  return limit;
}

interface DateParts {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
}

function getDateParts(date: Date, tz: string): DateParts {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(date).map((p) => [p.type, p.value])
    );
    const dowMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    return {
      minute: parseInt(parts["minute"], 10),
      hour: parseInt(parts["hour"], 10) % 24,
      dom: parseInt(parts["day"], 10),
      month: parseInt(parts["month"], 10),
      dow: dowMap[parts["weekday"]] ?? 0,
    };
  } catch {
    // Fallback: use UTC
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dom: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dow: date.getUTCDay(),
    };
  }
}

function matchesCronField(field: string, value: number, min: number, max: number): boolean {
  if (field === "*") return true;

  if (field.includes("/")) {
    const [range, stepStr] = field.split("/");
    const step = parseInt(stepStr, 10);
    const base = range === "*" ? min : parseInt(range.split("-")[0], 10);
    return (value - base) % step === 0 && value >= base && value <= max;
  }

  if (field.includes(",")) {
    return field.split(",").some((part) => matchesCronField(part, value, min, max));
  }

  if (field.includes("-")) {
    const [start, end] = field.split("-").map(Number);
    return value >= start && value <= end;
  }

  const num = parseInt(field, 10);
  // Normalise: day-of-week 7 == 0 (Sunday)
  if (num === 7 && min === 0 && max === 7) return value === 0;
  return num === value;
}

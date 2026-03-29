/**
 * Utility helpers for schedule trigger calculations.
 */

import {
  CronSchedule,
  IntervalSchedule,
  OnceSchedule,
  Schedule,
} from "./types";

// ---------------------------------------------------------------------------
// Cron helpers
// ---------------------------------------------------------------------------

/**
 * Minimal cron-expression parser that returns the next Date after `from`.
 * Supports the standard 5-field format: minute hour dom month dow.
 * Wildcards (*), lists (1,2,3), ranges (1-5), and step values (* /5) are
 * supported. This implementation covers the vast majority of real-world
 * expressions without pulling in a heavy dependency.
 */
export function getNextCronDate(expression: string, from: Date): Date {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expression}": expected 5 fields.`
    );
  }

  const [minuteField, hourField, domField, monthField, dowField] = fields;

  const expandField = (field: string, min: number, max: number): number[] => {
    const values = new Set<number>();
    const parts = field.split(",");
    for (const part of parts) {
      if (part === "*") {
        for (let i = min; i <= max; i++) values.add(i);
      } else if (part.startsWith("*/")) {
        const step = parseInt(part.slice(2), 10);
        for (let i = min; i <= max; i += step) values.add(i);
      } else if (part.includes("-")) {
        const [start, end] = part.split("-").map(Number);
        for (let i = start; i <= end; i++) values.add(i);
      } else if (part.includes("/")) {
        const [rangeOrStar, step] = part.split("/");
        const stepNum = parseInt(step, 10);
        if (rangeOrStar === "*") {
          for (let i = min; i <= max; i += stepNum) values.add(i);
        } else if (rangeOrStar.includes("-")) {
          const [start, end] = rangeOrStar.split("-").map(Number);
          for (let i = start; i <= end; i += stepNum) values.add(i);
        }
      } else {
        values.add(parseInt(part, 10));
      }
    }
    return Array.from(values).sort((a, b) => a - b);
  };

  const minutes = expandField(minuteField, 0, 59);
  const hours = expandField(hourField, 0, 23);
  const doms = expandField(domField, 1, 31);
  const months = expandField(monthField, 1, 12);
  const dows = expandField(dowField, 0, 6);

  // Start searching one minute after `from`
  const candidate = new Date(from.getTime() + 60_000);
  candidate.setSeconds(0, 0);

  // Safety: search at most 4 years ahead (to handle rare cron expressions)
  const limit = new Date(from.getTime() + 4 * 365 * 24 * 60 * 60 * 1000);

  while (candidate < limit) {
    const month = candidate.getMonth() + 1; // 1-based
    if (!months.includes(month)) {
      candidate.setMonth(candidate.getMonth() + 1);
      candidate.setDate(1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    const dom = candidate.getDate();
    const dow = candidate.getDay();
    const domWildcard = domField === "*";
    const dowWildcard = dowField === "*";

    let dateMatch: boolean;
    if (domWildcard && dowWildcard) {
      dateMatch = true;
    } else if (domWildcard) {
      dateMatch = dows.includes(dow);
    } else if (dowWildcard) {
      dateMatch = doms.includes(dom);
    } else {
      dateMatch = doms.includes(dom) || dows.includes(dow);
    }

    if (!dateMatch) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hours.includes(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minutes.includes(candidate.getMinutes())) {
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(candidate);
  }

  throw new Error(
    `Could not determine next run time for cron expression "${expression}".`
  );
}

// ---------------------------------------------------------------------------
// Interval helpers
// ---------------------------------------------------------------------------

export function getIntervalMs(schedule: IntervalSchedule): number {
  const { value, unit } = schedule;
  const unitMs: Record<IntervalSchedule["unit"], number> = {
    seconds: 1_000,
    minutes: 60_000,
    hours: 3_600_000,
    days: 86_400_000,
  };
  return value * unitMs[unit];
}

// ---------------------------------------------------------------------------
// Generic next-run helper
// ---------------------------------------------------------------------------

export function computeNextRunAt(schedule: Schedule, from: Date = new Date()): Date | null {
  switch (schedule.type) {
    case "cron": {
      return getNextCronDate(schedule.expression, from);
    }
    case "interval": {
      return new Date(from.getTime() + getIntervalMs(schedule));
    }
    case "once": {
      const runAt = new Date(schedule.runAt);
      return runAt > from ? runAt : null;
    }
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validateSchedule(schedule: Schedule): void {
  switch (schedule.type) {
    case "cron": {
      const fields = schedule.expression.trim().split(/\s+/);
      if (fields.length !== 5) {
        throw new Error(
          "Cron expression must have exactly 5 fields (minute hour dom month dow)."
        );
      }
      // Verify the expression resolves successfully
      getNextCronDate(schedule.expression, new Date());
      break;
    }
    case "interval": {
      if (!Number.isInteger(schedule.value) || schedule.value < 1) {
        throw new Error("Interval value must be a positive integer.");
      }
      const validUnits = ["seconds", "minutes", "hours", "days"];
      if (!validUnits.includes(schedule.unit)) {
        throw new Error(
          `Invalid interval unit "${schedule.unit}". Must be one of: ${validUnits.join(", ")}.`
        );
      }
      break;
    }
    case "once": {
      const runAt = new Date(schedule.runAt);
      if (isNaN(runAt.getTime())) {
        throw new Error(
          `Invalid ISO-8601 datetime string for "once" schedule: "${schedule.runAt}".`
        );
      }
      break;
    }
    default: {
      throw new Error(`Unknown schedule type.`);
    }
  }
}

import { ScheduleTrigger } from "./types";

/**
 * Cron/interval utility helpers for the agent-schedules module.
 *
 * Supported cron syntax: standard 5-field POSIX cron (minute hour dom month dow).
 * Extended 6-field (with seconds) is NOT supported here.
 */

// ---------------------------------------------------------------------------
// Interval helpers
// ---------------------------------------------------------------------------

/** Milliseconds in a minute */
const MS_MINUTE = 60_000;
/** Milliseconds in an hour */
const MS_HOUR = 3_600_000;
/** Milliseconds in a day */
const MS_DAY = 86_400_000;

export function intervalToMs(value: number, unit: "minutes" | "hours" | "days"): number {
  switch (unit) {
    case "minutes":
      return value * MS_MINUTE;
    case "hours":
      return value * MS_HOUR;
    case "days":
      return value * MS_DAY;
    default:
      throw new Error(`Unknown interval unit: ${unit}`);
  }
}

// ---------------------------------------------------------------------------
// Cron field definitions
// ---------------------------------------------------------------------------

interface CronFieldDef {
  min: number;
  max: number;
}

const CRON_FIELDS: CronFieldDef[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 },  // day-of-week (0=Sunday, 6=Saturday)
];

// ---------------------------------------------------------------------------
// Cron field parser
// ---------------------------------------------------------------------------

/**
 * Expand a single cron field token (e.g. "*/5", "1-5", "1,2,3", "*") into the
 * set of matching integer values within [fieldMin, fieldMax].
 *
 * Returns `null` when the field contains an out-of-range or non-numeric value.
 */
function parseField(
  token: string,
  fieldMin: number,
  fieldMax: number
): Set<number> | null {
  const values = new Set<number>();

  for (const part of token.split(",")) {
    if (part === "*") {
      for (let v = fieldMin; v <= fieldMax; v++) values.add(v);
      continue;
    }

    // Step syntax: */step or start-end/step
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepMatch) {
      const stepVal = parseInt(stepMatch[2], 10);
      if (isNaN(stepVal) || stepVal <= 0) return null;

      let rangeMin = fieldMin;
      let rangeMax = fieldMax;

      if (stepMatch[1] !== "*") {
        const rangeParts = stepMatch[1].split("-");
        if (rangeParts.length === 2) {
          rangeMin = parseInt(rangeParts[0], 10);
          rangeMax = parseInt(rangeParts[1], 10);
        } else {
          rangeMin = parseInt(stepMatch[1], 10);
          rangeMax = fieldMax;
        }
        if (
          isNaN(rangeMin) ||
          isNaN(rangeMax) ||
          rangeMin < fieldMin ||
          rangeMax > fieldMax ||
          rangeMin > rangeMax
        ) {
          return null;
        }
      }

      for (let v = rangeMin; v <= rangeMax; v += stepVal) values.add(v);
      continue;
    }

    // Range syntax: start-end
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);
      if (
        isNaN(lo) ||
        isNaN(hi) ||
        lo < fieldMin ||
        hi > fieldMax ||
        lo > hi
      ) {
        return null;
      }
      for (let v = lo; v <= hi; v++) values.add(v);
      continue;
    }

    // Single numeric value
    const num = parseInt(part, 10);
    if (isNaN(num) || num < fieldMin || num > fieldMax) return null;
    values.add(num);
  }

  if (values.size === 0) return null;
  return values;
}

// ---------------------------------------------------------------------------
// Cron expression parser
// ---------------------------------------------------------------------------

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

/**
 * Parse a 5-field cron expression into its constituent value sets.
 *
 * Returns `null` for any malformed or out-of-range expression.
 */
function parseCronExpression(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const results: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const parsed = parseField(fields[i], CRON_FIELDS[i].min, CRON_FIELDS[i].max);
    if (parsed === null) return null;
    results.push(parsed);
  }

  return {
    minutes: results[0],
    hours: results[1],
    daysOfMonth: results[2],
    months: results[3],
    daysOfWeek: results[4],
  };
}

// ---------------------------------------------------------------------------
// Next-run computation
// ---------------------------------------------------------------------------

/**
 * Compute the next Date at which a cron expression fires after `after`.
 *
 * Returns `null` when:
 *  - the expression is invalid/unparseable, OR
 *  - no matching time is found within 4 years (e.g. "30 Feb *")
 *
 * Callers should treat a `null` return as an invalid/unsatisfiable trigger and
 * must not persist it with a misleading `nextRunAt`.
 */
export function getNextCronDate(expr: string, after: Date = new Date()): Date | null {
  const parsed = parseCronExpression(expr);
  if (!parsed) return null;

  const { minutes, hours, daysOfMonth, months, daysOfWeek } = parsed;

  // Advance by one minute to avoid re-firing at the same minute.
  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limitDate = new Date(after);
  limitDate.setFullYear(limitDate.getFullYear() + 4);

  while (cursor < limitDate) {
    // Check month (cron months are 1-based; JS Date months are 0-based)
    if (!months.has(cursor.getMonth() + 1)) {
      // Advance to the 1st of the next matching month
      cursor.setDate(1);
      cursor.setHours(0, 0, 0, 0);
      cursor.setMonth(cursor.getMonth() + 1);
      continue;
    }

    // Check day-of-month and day-of-week
    const domMatch = daysOfMonth.has(cursor.getDate());
    const dowMatch = daysOfWeek.has(cursor.getDay());
    if (!domMatch || !dowMatch) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    // Check hour
    if (!hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }

    // Check minute
    if (!minutes.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }

    // All fields match — this is the next run time.
    return new Date(cursor);
  }

  // No matching time found within the look-ahead window — treat as invalid.
  return null;
}

// ---------------------------------------------------------------------------
// Next-run for a generic ScheduleTrigger
// ---------------------------------------------------------------------------

/**
 * Compute the next run date for a schedule trigger.
 *
 * Returns `null` when the trigger type is unknown, the cron expression is
 * invalid, or no valid run time exists within the look-ahead window.
 */
export function getNextRunDate(trigger: ScheduleTrigger, after?: Date): Date | null {
  switch (trigger.type) {
    case "cron": {
      const next = getNextCronDate(trigger.cronExpression, after);
      // Explicitly return null rather than a limit date for invalid expressions.
      return next;
    }
    case "interval": {
      const base = after ?? new Date();
      const ms = intervalToMs(trigger.intervalValue, trigger.intervalUnit);
      return new Date(base.getTime() + ms);
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Human-readable description of cron field positions. */
const FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"];

/**
 * Validate a cron expression string.
 *
 * Returns `{ valid: true }` on success or `{ valid: false, error: string }` on
 * failure with a descriptive message.
 */
export function validateCronExpression(
  expr: string
): { valid: true } | { valid: false; error: string } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return {
      valid: false,
      error: `Expected 5 cron fields (minute hour dom month dow), got ${fields.length}.`,
    };
  }

  for (let i = 0; i < 5; i++) {
    const result = parseField(fields[i], CRON_FIELDS[i].min, CRON_FIELDS[i].max);
    if (result === null) {
      return {
        valid: false,
        error: `Invalid ${FIELD_NAMES[i]} field "${fields[i]}". ` +
          `Expected values in [${CRON_FIELDS[i].min}–${CRON_FIELDS[i].max}].`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate an interval trigger's numeric value.
 */
export function validateIntervalValue(
  value: number,
  unit: "minutes" | "hours" | "days"
): { valid: true } | { valid: false; error: string } {
  if (!Number.isInteger(value) || value <= 0) {
    return {
      valid: false,
      error: `Interval value must be a positive integer, got ${value}.`,
    };
  }

  const minimums: Record<string, number> = { minutes: 1, hours: 1, days: 1 };
  const min = minimums[unit] ?? 1;
  if (value < min) {
    return {
      valid: false,
      error: `Interval value for unit "${unit}" must be at least ${min}.`,
    };
  }

  return { valid: true };
}

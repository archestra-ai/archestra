/**
 * Lightweight cron expression utilities.
 * Validates and computes the next Date for a 5-field cron expression.
 * Format: <minute> <hour> <day-of-month> <month> <day-of-week>
 * Supports: numbers, ranges (1-5), lists (1,2,3), step (*/5, 1-5/2), and wildcards (*).
 */

const FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6],  // day of week (0 = Sunday)
];

/** Parse a single cron field into an array of matching values */
function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  const parts = field.split(',');
  for (const part of parts) {
    const stepMatch = part.match(/^(.+?)\/(\d+)$/);
    let range = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;

    let rangeMin = min;
    let rangeMax = max;

    if (range !== '*') {
      const dashMatch = range.match(/^(\d+)-(\d+)$/);
      if (dashMatch) {
        rangeMin = parseInt(dashMatch[1], 10);
        rangeMax = parseInt(dashMatch[2], 10);
      } else {
        // Single number
        const n = parseInt(range, 10);
        if (isNaN(n) || n < min || n > max) {
          throw new Error(`Invalid cron field value: ${part} (range ${min}-${max})`);
        }
        values.add(n);
        continue;
      }
    }

    for (let i = rangeMin; i <= rangeMax; i += step) {
      values.add(i);
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

/**
 * Parse and validate a 5-field cron expression.
 * Throws if the expression is invalid.
 */
export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expression}": expected 5 fields, got ${fields.length}`
    );
  }

  const [minuteF, hourF, domF, monthF, dowF] = fields;
  const [minRange, maxRange] = [FIELD_RANGES[0], FIELD_RANGES[1], FIELD_RANGES[2], FIELD_RANGES[3], FIELD_RANGES[4]];

  return {
    minutes:     parseField(minuteF, 0, 59),
    hours:       parseField(hourF,   0, 23),
    daysOfMonth: parseField(domF,    1, 31),
    months:      parseField(monthF,  1, 12),
    daysOfWeek:  parseField(dowF,    0,  6),
  };
}

/**
 * Compute the next Date that matches a parsed cron expression, starting
 * strictly AFTER `from` (default: now).  Returns null if no match is found
 * within 4 years (effectively never).
 */
export function getNextCronDate(parsed: ParsedCron, from: Date = new Date()): Date | null {
  // Start searching from the next minute
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = new Date(from.getTime() + 4 * 365 * 24 * 60 * 60 * 1000);

  while (cursor < limit) {
    // Check month (cron months are 1-based, JS months are 0-based)
    if (!parsed.months.includes(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1);
      cursor.setDate(1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    // Check day of week and day of month
    const dayOfWeek = cursor.getDay(); // 0=Sun
    const dayOfMonth = cursor.getDate();
    if (
      !parsed.daysOfMonth.includes(dayOfMonth) ||
      !parsed.daysOfWeek.includes(dayOfWeek)
    ) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    // Check hour
    if (!parsed.hours.includes(cursor.getHours())) {
      const nextHour = parsed.hours.find((h) => h > cursor.getHours());
      if (nextHour === undefined) {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(0, 0, 0, 0);
      } else {
        cursor.setHours(nextHour, 0, 0, 0);
      }
      continue;
    }

    // Check minute
    if (!parsed.minutes.includes(cursor.getMinutes())) {
      const nextMinute = parsed.minutes.find((m) => m > cursor.getMinutes());
      if (nextMinute === undefined) {
        const nextHourIdx = parsed.hours.indexOf(cursor.getHours()) + 1;
        if (nextHourIdx >= parsed.hours.length) {
          cursor.setDate(cursor.getDate() + 1);
          cursor.setHours(0, 0, 0, 0);
        } else {
          cursor.setHours(parsed.hours[nextHourIdx], 0, 0, 0);
        }
      } else {
        cursor.setMinutes(nextMinute, 0, 0);
      }
      continue;
    }

    // All fields match
    return new Date(cursor);
  }

  return null; // No match in 4 years
}

/**
 * Validate a cron expression string.  Returns an error message or null.
 */
export function validateCronExpression(expression: string): string | null {
  try {
    parseCronExpression(expression);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Human-readable summary of a cron expression (best-effort).
 */
export function describeCronExpression(expression: string): string {
  const known: Record<string, string> = {
    '* * * * *':       'Every minute',
    '*/5 * * * *':     'Every 5 minutes',
    '*/15 * * * *':    'Every 15 minutes',
    '*/30 * * * *':    'Every 30 minutes',
    '0 * * * *':       'Every hour',
    '0 */6 * * *':     'Every 6 hours',
    '0 */12 * * *':    'Every 12 hours',
    '0 0 * * *':       'Daily at midnight',
    '0 9 * * *':       'Daily at 9:00 AM',
    '0 9 * * 1-5':     'Weekdays at 9:00 AM',
    '0 0 * * 0':       'Every Sunday at midnight',
    '0 0 1 * *':       'First day of every month',
  };
  return known[expression.trim()] ?? `Cron: ${expression}`;
}

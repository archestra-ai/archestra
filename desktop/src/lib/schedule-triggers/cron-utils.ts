/**
 * Cron expression utilities — no external dependencies.
 * Supports standard 5-field cron: minute hour dom month dow
 */

export interface CronField {
  min: number;
  max: number;
}

const FIELDS: Record<string, CronField> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 6 },
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseField(expr: string, field: CronField, nameMap?: Record<string, number>): number[] {
  const values = new Set<number>();

  // Replace named values
  let normalized = expr.toLowerCase();
  if (nameMap) {
    for (const [name, val] of Object.entries(nameMap)) {
      normalized = normalized.replace(new RegExp(name, 'g'), String(val));
    }
  }

  const parts = normalized.split(',');
  for (const part of parts) {
    if (part === '*') {
      for (let i = field.min; i <= field.max; i++) values.add(i);
    } else if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      let start = field.min;
      let end = field.max;
      if (range !== '*') {
        if (range.includes('-')) {
          const [s, e] = range.split('-').map(Number);
          start = s;
          end = e;
        } else {
          start = parseInt(range, 10);
        }
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes('-')) {
      const [s, e] = part.split('-').map(Number);
      for (let i = s; i <= e; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return Array.from(values).filter(v => v >= field.min && v <= field.max).sort((a, b) => a - b);
}

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  doms: number[];
  months: number[];
  dows: number[];
}

export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }
  return {
    minutes: parseField(parts[0], FIELDS.minute),
    hours: parseField(parts[1], FIELDS.hour),
    doms: parseField(parts[2], FIELDS.dom),
    months: parseField(parts[3], FIELDS.month, MONTH_NAMES),
    dows: parseField(parts[4], FIELDS.dow, DOW_NAMES),
  };
}

/**
 * Validate a cron expression. Returns null if valid, error message if invalid.
 */
export function validateCronExpression(expression: string): string | null {
  try {
    if (!expression || expression.trim() === '') return 'Cron expression is required';
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) return 'Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week)';
    parseCron(expression);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid cron expression';
  }
}

/**
 * Compute the next Date at which a cron expression fires after `after`.
 * Returns null if no next time can be found within 4 years.
 */
export function getNextCronDate(expression: string, after: Date = new Date()): Date | null {
  const cron = parseCron(expression);

  // Start 1 minute after the reference time
  const start = new Date(after);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const limit = new Date(start);
  limit.setFullYear(limit.getFullYear() + 4);

  const d = new Date(start);

  while (d < limit) {
    // Check month
    if (!cron.months.includes(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1);
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    // Check DOM
    if (!cron.doms.includes(d.getDate())) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    // Check DOW
    if (!cron.dows.includes(d.getDay())) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    // Check hour
    if (!cron.hours.includes(d.getHours())) {
      const nextHour = cron.hours.find(h => h > d.getHours());
      if (nextHour !== undefined) {
        d.setHours(nextHour, 0, 0, 0);
      } else {
        d.setDate(d.getDate() + 1);
        d.setHours(cron.hours[0], 0, 0, 0);
      }
      continue;
    }
    // Check minute
    if (!cron.minutes.includes(d.getMinutes())) {
      const nextMin = cron.minutes.find(m => m > d.getMinutes());
      if (nextMin !== undefined) {
        d.setMinutes(nextMin, 0, 0);
      } else {
        const nextHourIdx = cron.hours.indexOf(d.getHours());
        if (nextHourIdx >= 0 && nextHourIdx + 1 < cron.hours.length) {
          d.setHours(cron.hours[nextHourIdx + 1], cron.minutes[0], 0, 0);
        } else {
          d.setDate(d.getDate() + 1);
          d.setHours(cron.hours[0], cron.minutes[0], 0, 0);
        }
      }
      continue;
    }

    return d;
  }

  return null;
}

/**
 * Get a human-readable description of a cron expression.
 */
export function describeCronExpression(expression: string): string {
  const trimmed = expression.trim();

  const presets: Record<string, string> = {
    '* * * * *': 'Every minute',
    '0 * * * *': 'Every hour',
    '0 0 * * *': 'Every day at midnight',
    '0 9 * * *': 'Every day at 9:00 AM',
    '0 9 * * 1-5': 'Every weekday at 9:00 AM',
    '0 9 * * 1': 'Every Monday at 9:00 AM',
    '0 0 * * 0': 'Every Sunday at midnight',
    '0 0 1 * *': 'First day of every month',
  };

  if (presets[trimmed]) return presets[trimmed];

  try {
    parseCron(trimmed);
    return `Schedule: ${trimmed}`;
  } catch {
    return 'Invalid cron expression';
  }
}

/**
 * Format a Date as a human-friendly relative string (e.g. "in 5 minutes").
 */
export function formatRelativeTime(date: Date | string | null | undefined): string {
  if (!date) return 'Never';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);

  if (abs < 60_000) return diff > 0 ? 'in less than a minute' : 'just now';
  if (abs < 3_600_000) {
    const mins = Math.round(abs / 60_000);
    return diff > 0 ? `in ${mins} minute${mins !== 1 ? 's' : ''}` : `${mins} minute${mins !== 1 ? 's' : ''} ago`;
  }
  if (abs < 86_400_000) {
    const hrs = Math.round(abs / 3_600_000);
    return diff > 0 ? `in ${hrs} hour${hrs !== 1 ? 's' : ''}` : `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
  }
  const days = Math.round(abs / 86_400_000);
  return diff > 0 ? `in ${days} day${days !== 1 ? 's' : ''}` : `${days} day${days !== 1 ? 's' : ''} ago`;
}

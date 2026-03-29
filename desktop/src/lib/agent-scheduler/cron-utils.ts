/**
 * Utility helpers for cron expression parsing and next-run computation.
 * Uses a lightweight, dependency-free approach to avoid adding heavy libraries.
 */

interface CronField {
  min: number;
  max: number;
  values: number[] | null; // null means "any / *"
}

function parseField(raw: string, min: number, max: number): number[] | null {
  if (raw === "*") return null;

  const values = new Set<number>();

  for (const part of raw.split(",")) {
    // Range with optional step: e.g. "1-5/2"
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const [, rangePart, stepStr] = stepMatch;
      const step = parseInt(stepStr, 10);
      let rangeMin = min;
      let rangeMax = max;
      if (rangePart !== "*") {
        const dashIdx = rangePart.indexOf("-");
        if (dashIdx !== -1) {
          rangeMin = parseInt(rangePart.slice(0, dashIdx), 10);
          rangeMax = parseInt(rangePart.slice(dashIdx + 1), 10);
        } else {
          rangeMin = parseInt(rangePart, 10);
          rangeMax = max;
        }
      }
      for (let i = rangeMin; i <= rangeMax; i += step) {
        values.add(i);
      }
      continue;
    }

    // Plain range: "1-5"
    const dashIdx = part.indexOf("-");
    if (dashIdx !== -1) {
      const lo = parseInt(part.slice(0, dashIdx), 10);
      const hi = parseInt(part.slice(dashIdx + 1), 10);
      for (let i = lo; i <= hi; i++) values.add(i);
      continue;
    }

    // Plain number
    values.add(parseInt(part, 10));
  }

  return Array.from(values).sort((a, b) => a - b);
}

/**
 * Parse a standard 5-field cron expression.
 * Returns { minute, hour, dom, month, dow } each as sorted number[] or null (wildcard).
 */
export function parseCronExpression(expression: string): {
  minute: number[] | null;
  hour: number[] | null;
  dom: number[] | null;
  month: number[] | null;
  dow: number[] | null;
} {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expression}": expected 5 fields, got ${parts.length}`
    );
  }
  const [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;
  return {
    minute: parseField(minuteStr, 0, 59),
    hour: parseField(hourStr, 0, 23),
    dom: parseField(domStr, 1, 31),
    month: parseField(monthStr, 1, 12),
    dow: parseField(dowStr, 0, 6),
  };
}

function nextValue(
  values: number[] | null,
  current: number,
  min: number,
  max: number
): { value: number; wrapped: boolean } {
  if (values === null) {
    return { value: current, wrapped: false };
  }
  for (const v of values) {
    if (v >= current) return { value: v, wrapped: false };
  }
  return { value: values[0], wrapped: true };
}

/**
 * Compute the next Date at which the cron expression fires after `after`.
 * Returns null if no occurrence is found within 4 years.
 */
export function getNextCronDate(expression: string, after: Date): Date | null {
  const { minute, hour, dom, month, dow } = parseCronExpression(expression);

  // Start 1 minute after `after`
  const d = new Date(after.getTime() + 60_000);
  d.setSeconds(0, 0);

  const deadline = new Date(after.getTime() + 4 * 365 * 24 * 60 * 60 * 1000);

  // Safety limit iterations
  for (let iterations = 0; iterations < 525_600 * 4; iterations++) {
    if (d > deadline) return null;

    // Check month (1-based)
    const curMonth = d.getMonth() + 1;
    const nextMonth = nextValue(month, curMonth, 1, 12);
    if (nextMonth.wrapped) {
      d.setFullYear(d.getFullYear() + 1);
      d.setMonth(0, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (nextMonth.value !== curMonth) {
      d.setMonth(nextMonth.value - 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    // Check day-of-month and day-of-week
    const curDom = d.getDate();
    const curDow = d.getDay(); // 0=Sun

    const domOk = dom === null || dom.includes(curDom);
    const dowOk = dow === null || dow.includes(curDow);

    // If both are wildcards, both must match (i.e., always true)
    // If only one is specified, it acts as a restriction
    const dayOk = domOk && dowOk;

    if (!dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    // Check hour
    const curHour = d.getHours();
    const nextHour = nextValue(hour, curHour, 0, 23);
    if (nextHour.wrapped) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (nextHour.value !== curHour) {
      d.setHours(nextHour.value, 0, 0, 0);
      continue;
    }

    // Check minute
    const curMin = d.getMinutes();
    const nextMin = nextValue(minute, curMin, 0, 59);
    if (nextMin.wrapped) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (nextMin.value !== curMin) {
      d.setMinutes(nextMin.value, 0, 0);
      continue;
    }

    // All fields matched
    return new Date(d);
  }

  return null;
}

/**
 * Compute the next Date for an interval trigger.
 */
export function getNextIntervalDate(
  intervalMs: number,
  lastRunAt: Date | null
): Date {
  const base = lastRunAt ?? new Date();
  return new Date(base.getTime() + intervalMs);
}

/**
 * Return a human-readable label for a cron expression.
 * Handles common patterns; falls back to the raw expression.
 */
export function cronLabel(expression: string): string {
  const patterns: Array<[RegExp, string]> = [
    [/^0 \* \* \* \*$/, "Every hour"],
    [/^0 0 \* \* \*$/, "Daily at midnight"],
    [/^0 9 \* \* \*$/, "Daily at 9 AM"],
    [/^0 9 \* \* 1-5$/, "Weekdays at 9 AM"],
    [/^0 0 \* \* 1$/, "Weekly on Monday"],
    [/^0 0 1 \* \*$/, "Monthly on the 1st"],
    [/^\* \* \* \* \*$/, "Every minute"],
    [/^0 0 \* \* 0$/, "Weekly on Sunday"],
  ];
  for (const [re, label] of patterns) {
    if (re.test(expression.trim())) return label;
  }
  return expression;
}

/**
 * Validate a cron expression. Returns an error string or null if valid.
 */
export function validateCronExpression(expression: string): string | null {
  try {
    parseCronExpression(expression);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid cron expression";
  }
}

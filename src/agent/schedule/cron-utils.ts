/**
 * Cron utility helpers for schedule triggers.
 *
 * Uses the lightweight `croner` library which supports:
 *  - Standard 5-field expressions
 *  - IANA timezone strings
 *  - Next-run computation without spawning child processes
 */

import Croner from "croner";

/**
 * Validate a cron expression string.
 * Returns true if the expression is syntactically valid.
 */
export function isValidCronExpression(expression: string): boolean {
  try {
    // Croner throws on invalid expressions
    const job = new Croner(expression, { paused: true });
    job.stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the next N run dates for a cron expression.
 *
 * @param expression - A valid 5-field cron expression
 * @param timezone   - IANA timezone string (default: "UTC")
 * @param count      - How many upcoming dates to return (default: 5)
 * @param from       - Start from this date (default: now)
 */
export function getNextRunDates(
  expression: string,
  timezone = "UTC",
  count = 5,
  from: Date = new Date()
): Date[] {
  const dates: Date[] = [];
  let cursor = new Date(from);

  for (let i = 0; i < count; i++) {
    const job = new Croner(expression, {
      timezone,
      startAt: cursor,
      paused: true,
    });
    const next = job.nextRun(cursor);
    job.stop();
    if (!next) break;
    dates.push(next);
    // Advance 1 ms past this date so we get a distinct next date
    cursor = new Date(next.getTime() + 1);
  }

  return dates;
}

/**
 * Return the single next run date after `from` for a cron expression.
 */
export function getNextRunDate(
  expression: string,
  timezone = "UTC",
  from: Date = new Date()
): Date | null {
  const dates = getNextRunDates(expression, timezone, 1, from);
  return dates[0] ?? null;
}

/**
 * Compute the next run date for an interval schedule.
 *
 * @param intervalMs - Repeat interval in milliseconds
 * @param lastRunAt  - Last run time (default: now) — the next run is lastRunAt + intervalMs
 */
export function getNextIntervalRunDate(
  intervalMs: number,
  lastRunAt: Date = new Date()
): Date {
  return new Date(lastRunAt.getTime() + intervalMs);
}

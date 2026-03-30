/**
 * Cron utility helpers for Agent Schedule Triggers.
 *
 * Uses the `cron-parser` library for cron expression parsing and
 * `luxon` for robust timezone-aware datetime handling.
 *
 * NOTE: If the project does not already include these dependencies, add them:
 *   pnpm add cron-parser luxon
 *   pnpm add -D @types/luxon
 */

import cronParser from "cron-parser";
import { DateTime } from "luxon";

/**
 * Compute the next occurrence of a cron expression after `after` (defaults to now).
 *
 * @param expression  5-field cron expression, e.g. "0 9 * * 1"
 * @param timezone    IANA timezone string, e.g. "America/New_York"
 * @param after       Base date (defaults to current UTC time)
 * @returns ISO-8601 string of the next run time, or null if exhausted
 */
export function getNextCronRun(
  expression: string,
  timezone = "UTC",
  after?: Date
): string | null {
  try {
    const base = after ?? new Date();
    const interval = cronParser.parseExpression(expression, {
      currentDate: base,
      tz: timezone,
    });
    const next = interval.next().toDate();
    return DateTime.fromJSDate(next, { zone: timezone })
      .toUTC()
      .toISO();
  } catch {
    return null;
  }
}

/**
 * Compute the next occurrence for an interval trigger.
 *
 * @param intervalMs  Milliseconds between runs
 * @param lastRunAt   ISO-8601 string of the last run (defaults to now)
 * @returns ISO-8601 string of the next run time
 */
export function getNextIntervalRun(
  intervalMs: number,
  lastRunAt?: string | null
): string {
  const base = lastRunAt ? new Date(lastRunAt) : new Date();
  return new Date(base.getTime() + intervalMs).toISOString();
}

/**
 * Validate a cron expression.
 *
 * @param expression  5-field cron expression
 * @returns true if the expression is valid
 */
export function isValidCronExpression(expression: string): boolean {
  try {
    cronParser.parseExpression(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a human-readable description for common cron expressions.
 * Falls back to the raw expression string.
 */
export function describeCronExpression(expression: string): string {
  const well_known: Record<string, string> = {
    "* * * * *": "Every minute",
    "0 * * * *": "Every hour",
    "0 0 * * *": "Every day at midnight UTC",
    "0 9 * * *": "Every day at 09:00 UTC",
    "0 9 * * 1": "Every Monday at 09:00 UTC",
    "0 0 * * 1": "Every Monday at midnight UTC",
    "0 0 1 * *": "First day of every month at midnight UTC",
    "0 0 1 1 *": "Once a year on January 1st at midnight UTC",
  };
  return well_known[expression] ?? expression;
}

/**
 * Compute the next run timestamp for any trigger config type.
 * Returns null for event-based triggers.
 */
export function computeNextRunAt(
  config: import("./types").TriggerConfig,
  lastRunAt?: string | null
): string | null {
  switch (config.type) {
    case "cron":
      return getNextCronRun(
        config.expression,
        config.timezone ?? "UTC",
        lastRunAt ? new Date(lastRunAt) : undefined
      );
    case "interval":
      return getNextIntervalRun(config.intervalMs, lastRunAt);
    case "once":
      // A one-shot trigger's next run is exactly its `runAt` date
      return new Date(config.runAt) > new Date() ? config.runAt : null;
    case "event":
      // Event triggers do not have a predictable next run time
      return null;
  }
}

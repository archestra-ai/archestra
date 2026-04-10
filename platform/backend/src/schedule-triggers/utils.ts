import { Cron } from "croner";

export const SCHEDULE_TRIGGER_MINIMUM_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function normalizeCronExpression(expression: string): string {
  return expression.trim().replace(/\s+/g, " ");
}

export function normalizeTimezone(timezone: string): string {
  return timezone.trim();
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function createCron(params: {
  cronExpression: string;
  timezone: string;
}): Cron {
  return new Cron(normalizeCronExpression(params.cronExpression), {
    mode: "5-part",
    paused: true,
    timezone: normalizeTimezone(params.timezone),
  });
}

export function calculateNextDueAt(params: {
  cronExpression: string;
  timezone: string;
  from?: Date;
}): Date | null {
  return createCron(params).nextRun(params.from ?? new Date());
}

export function validateCronMinimumInterval(params: {
  cronExpression: string;
  timezone: string;
}): void {
  const cron = createCron(params);
  // Using 2000-01-01 as a stable reference date to avoid DST edge cases affecting the test
  const refDate = new Date("2000-01-01T00:00:00Z");

  const firstRun = cron.nextRun(refDate);
  if (!firstRun) return;

  const secondRun = cron.nextRun(firstRun);
  if (!secondRun) return;

  const interval = secondRun.getTime() - firstRun.getTime();
  if (interval < SCHEDULE_TRIGGER_MINIMUM_INTERVAL_MS) {
    throw new Error(
      "Schedule must not fire more frequently than once per hour",
    );
  }
}

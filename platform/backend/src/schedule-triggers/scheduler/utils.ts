import Cron from "croner";

export function normalizeCronExpression(cron: string): string {
  return cron.trim();
}

export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch (e) {
    return false;
  }
}

export function normalizeTimezone(timezone?: string): string {
  if (!timezone) return "UTC";
  return timezone.trim();
}

export function calculateNextDueAt(
  params: {
    scheduleKind: string;
    cronExpression?: string | null;
    intervalSeconds?: number | null;
    runAt?: Date | null;
    timezone?: string;
  },
  fromDate: Date = new Date(),
): Date | null {
  const { scheduleKind, cronExpression, intervalSeconds, runAt, timezone = "UTC" } = params;

  if (scheduleKind === "cron" && cronExpression) {
    try {
      const job = new Cron(cronExpression, { timezone });
      const nextRun = job.nextRun(fromDate);
      return nextRun || null;
    } catch (err) {
      return null;
    }
  }

  if (scheduleKind === "interval" && intervalSeconds) {
    return new Date(fromDate.getTime() + intervalSeconds * 1000);
  }

  if (scheduleKind === "one-time" && runAt) {
    // If runAt is in the past compared to fromDate, it's already due or missed.
    // If it's in the future, it's the next due.
    return runAt > fromDate ? runAt : null;
  }

  return null;
}

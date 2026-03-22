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
  cronExp: string,
  timezone: string,
  fromDate: Date = new Date(),
): Date | null {
  try {
    const job = new Cron(cronExp, { timezone });
    const nextRun = job.nextRun(fromDate);
    return nextRun || null;
  } catch (err) {
    return null;
  }
}

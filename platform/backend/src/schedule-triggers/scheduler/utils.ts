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

export interface CronScheduleParams {
  scheduleKind: "cron";
  cronExpression: string;
  timezone?: string;
}

export interface IntervalScheduleParams {
  scheduleKind: "interval";
  intervalSeconds: number;
}

export interface OneTimeScheduleParams {
  scheduleKind: "one-time";
  runAt: Date | string;
}

export type ScheduleParams =
  | CronScheduleParams
  | IntervalScheduleParams
  | OneTimeScheduleParams;

export function calculateNextDueAt(
  params: ScheduleParams,
  fromDate: Date = new Date(),
): Date | null {
  if (params.scheduleKind === "cron") {
    try {
      const job = new Cron(params.cronExpression, {
        timezone: params.timezone || "UTC",
      });
      const nextRun = job.nextRun(fromDate);
      return nextRun || null;
    } catch (err) {
      return null;
    }
  }

  if (params.scheduleKind === "interval") {
    return new Date(fromDate.getTime() + params.intervalSeconds * 1000);
  }

  if (params.scheduleKind === "one-time") {
    const runAt =
      params.runAt instanceof Date ? params.runAt : new Date(params.runAt);
    return runAt > fromDate ? runAt : null;
  }

  return null;
}

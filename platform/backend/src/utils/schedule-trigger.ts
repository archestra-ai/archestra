import { Cron } from "croner";

export function normalizeCronExpression(expression: string): string {
  return expression.trim().replace(/\s+/g, " ");
}

export function normalizeTimezone(timezone: string): string {
  return timezone.trim();
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

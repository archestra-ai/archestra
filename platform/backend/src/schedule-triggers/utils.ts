import { ApiError } from "@shared";
import { Cron } from "croner";

export const FORM_SHAPE_CRON_ERROR_MESSAGE =
  "Cron must be 'M * * * *' (hourly, M=0-59) or 'M H * * D' (daily, H=0-23, D='*' or comma-separated weekdays 0-6 with Sun=0). Ranges, steps, day-of-month and month fields are not supported.";

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

export function isFormShapeCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [min, hr, dom, mon, dow] = parts;

  if (dom !== "*" || mon !== "*") return false;
  if (!MINUTE_REGEX.test(min)) return false;

  if (hr === "*" && dow === "*") return true;
  if (!HOUR_REGEX.test(hr)) return false;

  if (dow === "*") return true;

  const days = dow.split(",");

  if (days.length === 0 || days.length > 7) return false;

  const seen = new Set<number>();

  for (const d of days) {
    if (!WEEKDAY_REGEX.test(d)) return false;
    const n = Number(d);
    if (seen.has(n)) return false;
    seen.add(n);
  }

  return true;
}

export function assertValidCronAndTimezone(params: {
  cronExpression: string;
  timezone: string;
}): void {
  const trimmedCron = params.cronExpression?.trim();
  const trimmedTz = params.timezone?.trim();

  if (!trimmedCron) {
    throw new ApiError(400, "Cron expression is required");
  }
  if (!trimmedTz) {
    throw new ApiError(400, "Timezone is required");
  }
  if (!isValidTimezone(trimmedTz)) {
    throw new ApiError(400, "Timezone must be a valid IANA timezone");
  }

  try {
    createCron({ cronExpression: trimmedCron, timezone: trimmedTz });
  } catch (error) {
    throw new ApiError(
      400,
      error instanceof Error ? error.message : "Invalid cron expression",
    );
  }

  if (!isFormShapeCron(trimmedCron)) {
    throw new ApiError(400, FORM_SHAPE_CRON_ERROR_MESSAGE);
  }
}

const MINUTE_REGEX = /^([0-9]|[1-5][0-9])$/;
const HOUR_REGEX = /^([0-9]|1[0-9]|2[0-3])$/;
const WEEKDAY_REGEX = /^[0-6]$/;

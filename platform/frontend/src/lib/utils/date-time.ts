import {
  addHours,
  addMonths,
  addWeeks,
  format,
  formatDistanceToNow,
} from "date-fns";
import type { LimitCleanupInterval } from "@/components/limit-cleanup-interval-select";

export function formatDate({
  date,
  dateFormat = "MM/dd/yyyy HH:mm:ss",
}: {
  date: string;
  dateFormat?: string;
}) {
  return format(new Date(date), dateFormat);
}

export function formatRelativeTime(
  date: Date | string | null,
  options?: {
    neverLabel?: string;
    pastLabel?: string;
    invalidLabel?: string;
  },
): string {
  const neverLabel = options?.neverLabel ?? "Never";
  const pastLabel = options?.pastLabel ?? "Expired";
  const invalidLabel = options?.invalidLabel ?? neverLabel;

  if (!date) return neverLabel;

  const parsedDate = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(parsedDate.getTime())) {
    return invalidLabel;
  }

  if (parsedDate <= new Date()) {
    return pastLabel;
  }

  return formatDistanceToNow(parsedDate, { addSuffix: true });
}

export function getNextCleanupTime(
  lastCleanup: string | null,
  cleanupInterval: LimitCleanupInterval | null | undefined,
): Date | null {
  if (!lastCleanup || !cleanupInterval) return null;

  const lastCleanupDate = new Date(lastCleanup);
  if (Number.isNaN(lastCleanupDate.getTime())) return null;

  const intervalMap: Record<LimitCleanupInterval, (date: Date) => Date> = {
    "1h": (date) => addHours(date, 1),
    "12h": (date) => addHours(date, 12),
    "24h": (date) => addHours(date, 24),
    "1w": (date) => addWeeks(date, 1),
    "1m": (date) => addMonths(date, 1),
  };

  return intervalMap[cleanupInterval](lastCleanupDate);
}

export function formatRelativeTimeFromNow(
  date: Date | string | null,
  options?: {
    neverLabel?: string;
    invalidLabel?: string;
  },
): string {
  const neverLabel = options?.neverLabel ?? "Never";
  const invalidLabel = options?.invalidLabel ?? neverLabel;

  if (!date) return neverLabel;

  const parsedDate = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(parsedDate.getTime())) {
    return invalidLabel;
  }

  return formatDistanceToNow(parsedDate, { addSuffix: true });
}

export function formatLocalDateTime(date: Date | string | null): string | null {
  if (!date) return null;

  const parsedDate = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(parsedDate.getTime())) return null;

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return `${parsedDate.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  })} (${timeZone})`;
}

import { format, formatDistanceToNow } from "date-fns";

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

const CLEANUP_INTERVAL_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Calculate the next reset time for a limit based on lastCleanup + cleanupInterval.
 */
export function getNextResetTime(
  lastCleanup: string | Date | null | undefined,
  cleanupInterval: string | null | undefined,
): Date | null {
  if (!lastCleanup) return null;

  const last =
    typeof lastCleanup === "string" ? new Date(lastCleanup) : lastCleanup;
  if (Number.isNaN(last.getTime())) return null;

  const interval = cleanupInterval ?? "1w";
  const intervalMs = CLEANUP_INTERVAL_MS[interval] ?? CLEANUP_INTERVAL_MS["1w"];
  const next = new Date(last.getTime() + intervalMs);

  // If next reset is in the past, calculate from now
  if (next < new Date()) {
    return new Date(Date.now() + intervalMs);
  }

  return next;
}

/**
 * Format a countdown to the next limit reset.
 * Returns string like "resets in 3h" or null if no cleanup info.
 */
export function formatResetCountdown(
  lastCleanup: string | Date | null | undefined,
  cleanupInterval: string | null | undefined,
): string | null {
  const nextReset = getNextResetTime(lastCleanup, cleanupInterval);
  if (!nextReset) return null;

  if (nextReset <= new Date()) return "Resetting soon";

  return `resets ${formatDistanceToNow(nextReset, { addSuffix: false })}`;
}

import {
  format,
  formatDistanceToNow,
  formatDistanceToNowStrict,
} from "date-fns";

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
    /** "1 hour ago" rather than "about 1 hour ago", for tight spaces. */
    strict?: boolean;
  },
): string {
  const neverLabel = options?.neverLabel ?? "Never";
  const invalidLabel = options?.invalidLabel ?? neverLabel;

  if (!date) return neverLabel;

  const parsedDate = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(parsedDate.getTime())) {
    return invalidLabel;
  }

  return options?.strict
    ? formatDistanceToNowStrict(parsedDate, { addSuffix: true })
    : formatDistanceToNow(parsedDate, { addSuffix: true });
}

import { format } from "date-fns";

/**
 * A time range as people write it: each end is either an exact time
 * ("2026-10-13 14:30", or a stored ISO timestamp) or relative to now ("now",
 * "now-6h"). Relative ends stay relative, so "Last 6 hours" keeps rolling
 * forward instead of freezing at the moment it was picked.
 */
export type TimeRange = { from: string; to: string };

export type QuickRange = TimeRange & { label: string };

/** Ranges offered for one click, shortest first. */
export const QUICK_RANGES: QuickRange[] = [
  { from: "now-5m", to: "now", label: "Last 5 minutes" },
  { from: "now-15m", to: "now", label: "Last 15 minutes" },
  { from: "now-30m", to: "now", label: "Last 30 minutes" },
  { from: "now-1h", to: "now", label: "Last 1 hour" },
  { from: "now-3h", to: "now", label: "Last 3 hours" },
  { from: "now-6h", to: "now", label: "Last 6 hours" },
  { from: "now-12h", to: "now", label: "Last 12 hours" },
  { from: "now-24h", to: "now", label: "Last 24 hours" },
  { from: "now-2d", to: "now", label: "Last 2 days" },
  { from: "now-7d", to: "now", label: "Last 7 days" },
  { from: "now-30d", to: "now", label: "Last 30 days" },
  { from: "now-90d", to: "now", label: "Last 90 days" },
  { from: "now-12M", to: "now", label: "Last 12 months" },
  { from: "now/d", to: "now", label: "Today so far" },
  { from: "now-1d/d", to: "now/d", label: "Yesterday" },
  { from: "now/w", to: "now", label: "This week so far" },
];

/** No time filter, where a page's data allows asking for everything. */
export const ALL_TIME_RANGE: TimeRange = { from: "all", to: "now" };

export function isAllTime(range: TimeRange) {
  return range.from.trim() === ALL_TIME_RANGE.from;
}

/**
 * The moment a range end names, or undefined when the text names none.
 *
 * Exact: "2026-10-13", "2026-10-13 14:30" (local time; "T" works in place of
 * the space) or a full ISO timestamp. Relative: "now", "now-<n><unit>" with a
 * unit of m (minutes), h, d, w, M (months) or y, optionally rounded down to
 * the start of a day or week with "/d" or "/w" ("now/d" is local midnight).
 */
export function parseTimeExpression(text: string, now: Date): Date | undefined {
  const trimmed = text.trim();
  const relative = RELATIVE_PATTERN.exec(trimmed);
  if (relative) {
    const [, amount, unit, roundTo] = relative;
    const date = new Date(now);
    if (amount && unit) subtract(date, Number(amount), unit);
    if (roundTo === "d") date.setHours(0, 0, 0, 0);
    if (roundTo === "w") {
      // Weeks start on Monday.
      date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      date.setHours(0, 0, 0, 0);
    }
    return date;
  }
  const absolute = ABSOLUTE_PATTERN.exec(trimmed);
  if (absolute) {
    const [, year, month, day, hour = "0", minute = "0"] = absolute;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
    );
    // Reject what the Date constructor silently rolls over ("2026-02-31").
    const exact =
      date.getFullYear() === Number(year) &&
      date.getMonth() === Number(month) - 1 &&
      date.getDate() === Number(day) &&
      date.getHours() === Number(hour) &&
      date.getMinutes() === Number(minute);
    return exact ? date : undefined;
  }
  if (ISO_PATTERN.test(trimmed)) {
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

/** Both ends of a range as moments, or undefined if either names none. */
export function resolveTimeRange(
  range: TimeRange,
  now: Date,
): { start: Date; end: Date } | undefined {
  const start = parseTimeExpression(range.from, now);
  const end = parseTimeExpression(range.to, now);
  if (!start || !end) return undefined;
  return { start, end };
}

/** True when the range moves with the clock, so it must be re-resolved. */
export function isRelativeTimeRange(range: TimeRange) {
  return isRelative(range.from) || isRelative(range.to);
}

/** The words a range goes by: its quick range's name, else its two ends. */
export function describeTimeRange(range: TimeRange, now: Date): string {
  if (isAllTime(range)) return "All time";
  const quick = findQuickRange(range);
  if (quick) return quick.label;
  const resolved = resolveTimeRange(range, now);
  if (!resolved) return `${range.from} to ${range.to}`;
  const to = isRelative(range.to) && range.to.trim() === "now";
  return `${formatMoment(resolved.start)} – ${to ? "now" : formatMoment(resolved.end, resolved.start)}`;
}

/** The exact times a range covers, for showing beside its name. */
export function describeResolvedTimeRange(range: TimeRange, now: Date) {
  const resolved = resolveTimeRange(range, now);
  if (!resolved) return "";
  return `${formatMoment(resolved.start)} – ${formatMoment(resolved.end, resolved.start)}`;
}

export function findQuickRange(range: TimeRange): QuickRange | undefined {
  return QUICK_RANGES.find(
    (quick) => quick.from === range.from.trim() && quick.to === range.to.trim(),
  );
}

/**
 * The same span moved one span earlier (-1) or later (+1), as exact times. A
 * later span never runs past now: it stops there and keeps its length.
 */
export function shiftTimeRange(
  range: TimeRange,
  direction: -1 | 1,
  now: Date,
): TimeRange | undefined {
  const resolved = resolveTimeRange(range, now);
  if (!resolved) return undefined;
  const span = resolved.end.getTime() - resolved.start.getTime();
  let start = resolved.start.getTime() + direction * span;
  let end = resolved.end.getTime() + direction * span;
  if (end > now.getTime()) {
    end = now.getTime();
    start = end - span;
  }
  return { from: toExact(new Date(start)), to: toExact(new Date(end)) };
}

/**
 * Twice the span around the same middle. A range that ends now stays ending
 * now and reaches twice as far back.
 */
export function zoomOutTimeRange(
  range: TimeRange,
  now: Date,
): TimeRange | undefined {
  const resolved = resolveTimeRange(range, now);
  if (!resolved) return undefined;
  const span = resolved.end.getTime() - resolved.start.getTime();
  if (range.to.trim() === "now") {
    const minutes = Math.max(1, Math.round((span * 2) / 60_000));
    return { from: `now-${minutes}m`, to: "now" };
  }
  const end = Math.min(now.getTime(), resolved.end.getTime() + span / 2);
  return {
    from: toExact(new Date(end - span * 2)),
    to: toExact(new Date(end)),
  };
}

/** An exact range end, in the form people type. */
export function toExact(date: Date) {
  return format(date, "yyyy-MM-dd HH:mm");
}

/** The browser's offset from UTC, as "UTC+02:00". */
export function describeTimezone(now: Date) {
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

// ===

function isRelative(text: string) {
  return RELATIVE_PATTERN.test(text.trim());
}

function subtract(date: Date, amount: number, unit: string) {
  if (unit === "M") date.setMonth(date.getMonth() - amount);
  else if (unit === "y") date.setFullYear(date.getFullYear() - amount);
  else date.setTime(date.getTime() - amount * UNIT_MS[unit]);
}

function formatMoment(date: Date, sameDayAs?: Date) {
  if (
    sameDayAs &&
    date.getFullYear() === sameDayAs.getFullYear() &&
    date.getMonth() === sameDayAs.getMonth() &&
    date.getDate() === sameDayAs.getDate()
  ) {
    return format(date, "HH:mm");
  }
  return format(
    date,
    date.getFullYear() === new Date().getFullYear()
      ? "MMM d, HH:mm"
      : "MMM d yyyy, HH:mm",
  );
}

const RELATIVE_PATTERN = /^now(?:\s*-\s*(\d+)\s*([mhdwMy]))?(?:\/([dw]))?$/;
const ABSOLUTE_PATTERN =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/;
const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

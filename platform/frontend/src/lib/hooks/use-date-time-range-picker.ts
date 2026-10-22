"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  describeTimeRange,
  resolveTimeRange,
  type TimeRange,
} from "@/components/time-range-picker/time-range";

export interface UseDateTimeRangePickerOptions {
  startDateFromUrl: string | null;
  endDateFromUrl: string | null;
  onDateRangeChange: (params: {
    startDate: string | null;
    endDate: string | null;
  }) => void;
}

export interface UseDateTimeRangePickerReturn {
  /** The range as written, or null while the page is not filtering by time. */
  range: TimeRange | null;
  setRange: (range: TimeRange) => void;
  /** Where the range starts, or undefined while there is none. */
  startDate: Date | undefined;
  /** Where the range ends, or undefined when it runs up to now. */
  endDate: Date | undefined;
  clearDateRange: () => void;
  getDateRangeDisplay: () => string | null;
  startDateParam: string | undefined;
  endDateParam: string | undefined;
}

/**
 * A page's time filter, kept in its URL as written ("now-6h" to "now", or two
 * exact times) so a relative range keeps rolling forward on reload and in a
 * shared link. A relative range resolves against the moment it was loaded or
 * picked and then holds still: the list never refreshes under the reader, and
 * picking the range again or reloading brings it up to date.
 */
export function useDateTimeRangePicker({
  startDateFromUrl,
  endDateFromUrl,
  onDateRangeChange,
}: UseDateTimeRangePickerOptions): UseDateTimeRangePickerReturn {
  const [range, setRangeState] = useState<TimeRange | null>(() =>
    validRange(startDateFromUrl, endDateFromUrl),
  );
  // The URL wins, so a shared link shows its own range; without one the page
  // takes the range last picked on any log page, so switching tabs keeps it.
  // Read after mount: the server render has no storage to agree with.
  const hasUrlRange = startDateFromUrl !== null;
  useEffect(() => {
    if (hasUrlRange) return;
    const stored = readStoredRange();
    if (stored) {
      setRangeState(stored);
      setAnchor(startOfMinute());
    }
  }, [hasUrlRange]);
  // Resolved to the start of the minute, so queries keep a stable key.
  const [anchor, setAnchor] = useState(startOfMinute);
  const resolved = useMemo(
    () => (range ? resolveTimeRange(range, new Date(anchor)) : undefined),
    [range, anchor],
  );
  // A range that runs up to now leaves its end open, so rows written since
  // it was resolved still show on the next fetch.
  const endsNow = range?.to.trim() === "now";

  const setRange = useCallback(
    (next: TimeRange) => {
      setRangeState(next);
      setAnchor(startOfMinute());
      storeRange(next);
      onDateRangeChange({ startDate: next.from, endDate: next.to });
    },
    [onDateRangeChange],
  );

  const clearDateRange = useCallback(() => {
    setRangeState(null);
    storeRange(null);
    onDateRangeChange({ startDate: null, endDate: null });
  }, [onDateRangeChange]);

  const getDateRangeDisplay = useCallback(
    () => (range ? describeTimeRange(range, new Date(anchor)) : null),
    [range, anchor],
  );

  return {
    range,
    setRange,
    startDate: resolved?.start,
    endDate: endsNow ? undefined : resolved?.end,
    clearDateRange,
    getDateRangeDisplay,
    startDateParam: resolved?.start.toISOString(),
    endDateParam: endsNow ? undefined : resolved?.end.toISOString(),
  };
}

// ===

// A hand-edited or stale value whose ends name no moment is no filter at all,
// rather than a broken one that the button would show as gibberish.
function validRange(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): TimeRange | null {
  if (!startDate) return null;
  const range = { from: startDate, to: endDate ?? "now" };
  return resolveTimeRange(range, new Date()) ? range : null;
}

function readStoredRange(): TimeRange | null {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "null",
    );
    return validRange(stored?.from, stored?.to);
  } catch {
    return null;
  }
}

function storeRange(range: TimeRange | null) {
  try {
    if (range) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(range));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode); the URL still holds it.
  }
}

/** One range for every log page in this browser. */
const STORAGE_KEY = "archestra-logs-time-range";

function startOfMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

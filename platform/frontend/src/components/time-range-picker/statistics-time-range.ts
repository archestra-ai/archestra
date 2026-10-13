"use client";

import {
  parseCustomStatisticsTimeframe,
  type StatisticsTimeFrame,
  StatisticsTimeFrameSchema,
} from "@archestra/shared";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ALL_TIME_RANGE,
  isAllTime,
  isRelativeTimeRange,
  resolveTimeRange,
  type TimeRange,
} from "./time-range";
import { useMinute } from "./use-minute";

/**
 * The time range of a statistics page (Costs, My Usage) and the timeframe its
 * queries send. The range stays as picked, relative or exact, in the URL's
 * `timeframe` param and in this browser under `storageKey`, so "Last 6 hours"
 * is still the last 6 hours after a reload. The statistics API only knows a
 * few ranges by name ("24h"); any other relative range is sent as its exact
 * bounds, re-resolved every minute.
 */
export function useStatisticsTimeRange({
  storageKey,
  defaultTimeframe,
}: {
  storageKey: string;
  defaultTimeframe: StatisticsTimeFrame;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [range, setRangeState] = useState<TimeRange>(() =>
    statisticsTimeframeToTimeRange(defaultTimeframe),
  );
  // The real range (URL or this browser) is only known once the effect below
  // has run; queries wait for it, so a page load does not fire a throwaway
  // round for the default range.
  const [isResolved, setIsResolved] = useState(false);

  useEffect(() => {
    setRangeState(
      decodeRange(searchParams.get("timeframe") ?? readStored(storageKey)) ??
        statisticsTimeframeToTimeRange(defaultTimeframe),
    );
    setIsResolved(true);
  }, [searchParams, storageKey, defaultTimeframe]);

  const minute = useMinute(
    isRelativeTimeRange(range) && namedTimeframe(range) === undefined,
  );
  const timeframe = useMemo(
    () =>
      timeRangeToStatisticsTimeframe(range, new Date(minute)) ??
      defaultTimeframe,
    [range, minute, defaultTimeframe],
  );

  const setRange = useCallback(
    (next: TimeRange) => {
      const encoded = encodeRange(next);
      if (!encoded) return;
      setRangeState(next);
      try {
        window.localStorage.setItem(storageKey, encoded);
      } catch {
        // Storage can be unavailable (private mode); the URL still holds it.
      }
      const params = new URLSearchParams(searchParams);
      params.set("timeframe", encoded);
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams, storageKey],
  );

  return { range, setRange, timeframe, isResolved };
}

/**
 * The statistics API's timeframe for a range. Ranges it knows by name ("24h")
 * keep that name; any other range is sent as its exact bounds at `now`.
 */
export function timeRangeToStatisticsTimeframe(
  range: TimeRange,
  now: Date,
): StatisticsTimeFrame | undefined {
  const named = namedTimeframe(range);
  if (named) return named;
  const resolved = resolveTimeRange(range, now);
  if (!resolved || resolved.end <= resolved.start) return undefined;
  return `custom:${resolved.start.toISOString()}_${resolved.end.toISOString()}`;
}

/** The range a statistics timeframe stands for, as the picker shows it. */
export function statisticsTimeframeToTimeRange(
  timeframe: StatisticsTimeFrame,
): TimeRange {
  if (timeframe === "all") return ALL_TIME_RANGE;
  const preset = PRESETS.find(([, name]) => name === timeframe);
  if (preset) return { from: preset[0], to: "now" };
  // Exact bounds keep their seconds: a range that ends at 23:59:59.999 must
  // not lose its last minute on the way back to the API.
  const custom = parseCustomStatisticsTimeframe(timeframe);
  if (custom) {
    return {
      from: custom.startTime.toISOString(),
      to: custom.endTime.toISOString(),
    };
  }
  return { from: "now-24h", to: "now" };
}

// ===

function namedTimeframe(range: TimeRange): StatisticsTimeFrame | undefined {
  if (isAllTime(range)) return "all";
  if (range.to.trim() !== "now") return undefined;
  return PRESETS.find(([from]) => from === range.from.trim())?.[1];
}

/**
 * How a range is kept in the URL and in storage: the API's name where it has
 * one, a relative range as written ("now-6h..now"), an exact one as the API's
 * custom bounds (the form older links already use).
 */
function encodeRange(range: TimeRange): string | undefined {
  const named = namedTimeframe(range);
  if (named) return named;
  if (isRelativeTimeRange(range)) {
    return resolveTimeRange(range, new Date())
      ? `${range.from.trim()}${RANGE_SEPARATOR}${range.to.trim()}`
      : undefined;
  }
  return timeRangeToStatisticsTimeframe(range, new Date());
}

function decodeRange(raw: string | null): TimeRange | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("custom:") && raw.includes(RANGE_SEPARATOR)) {
    const [from, to] = raw.split(RANGE_SEPARATOR);
    const range = { from, to };
    return resolveTimeRange(range, new Date()) ? range : undefined;
  }
  const { success, data } = StatisticsTimeFrameSchema.safeParse(raw);
  return success ? statisticsTimeframeToTimeRange(data) : undefined;
}

function readStored(storageKey: string) {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

const RANGE_SEPARATOR = "..";

const PRESETS: Array<[string, StatisticsTimeFrame]> = [
  ["now-5m", "5m"],
  ["now-15m", "15m"],
  ["now-30m", "30m"],
  ["now-1h", "1h"],
  ["now-24h", "24h"],
  ["now-7d", "7d"],
  ["now-30d", "30d"],
  ["now-90d", "90d"],
  ["now-12M", "12m"],
];

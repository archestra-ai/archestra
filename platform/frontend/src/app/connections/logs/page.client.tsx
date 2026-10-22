"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { useLogsHeaderAction } from "@/app/_parts/logs-section-layout";
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { ConnectionExplorer } from "./_components/connection-explorer";
import type { ConnectionsWindow } from "./_components/connections-window";

/** What the page shows until a range is picked. */
const DEFAULT_DAYS = 30;

export default function ConnectionLogsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Rounded to the minute, so a render or remount reuses the same queries.
  const [defaultStart] = useState(() => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    return new Date(minute - DEFAULT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  });

  const picker = useDateTimeRangePicker({
    startDateFromUrl: searchParams.get("startDate"),
    endDateFromUrl: searchParams.get("endDate"),
    onDateRangeChange: useCallback(
      ({ startDate, endDate }) => {
        const params = new URLSearchParams(searchParams.toString());
        params.delete("cursor");
        params.delete("page");
        for (const [key, value] of Object.entries({ startDate, endDate })) {
          if (value) params.set(key, value);
          else params.delete(key);
        }
        router.push(`${pathname}?${params.toString()}`, { scroll: false });
      },
      [searchParams, router, pathname],
    ),
  });
  // Every log page keeps its time range in the header's top-right corner.
  const timeRangePicker = useMemo(
    () => (
      <TimeRangePicker
        value={picker.range}
        onChange={picker.setRange}
        placeholder="Last 30 days"
        onClear={picker.clearDateRange}
      />
    ),
    [picker.range, picker.setRange, picker.clearDateRange],
  );
  useLogsHeaderAction(timeRangePicker);
  const picked = picker.startDateParam !== undefined;
  const rangeDisplay = picker.getDateRangeDisplay();
  const window = useMemo<ConnectionsWindow>(
    () => ({
      startDate: picker.startDateParam ?? defaultStart,
      endDate: picker.endDateParam,
      label: picked
        ? (rangeDisplay ?? "picked range")
        : `last ${DEFAULT_DAYS} days`,
      picked,
    }),
    [
      picker.startDateParam,
      picker.endDateParam,
      defaultStart,
      picked,
      rangeDisplay,
    ],
  );

  return (
    <ErrorBoundary>
      <ConnectionExplorer window={window} />
    </ErrorBoundary>
  );
}

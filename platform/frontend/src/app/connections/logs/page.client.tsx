"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { FilterBar, filterControlClass } from "@/components/filter-bar";
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { AgentAdoptionOverview } from "./_components/agent-adoption";
import { ConnectionLogTable } from "./_components/connection-log-table";
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
        for (const [key, value] of Object.entries({ startDate, endDate })) {
          if (value) params.set(key, value);
          else params.delete(key);
        }
        router.push(`${pathname}?${params.toString()}`, { scroll: false });
      },
      [searchParams, router, pathname],
    ),
  });
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
    <div className="space-y-8">
      {/* One range for the whole page: tiles, chart, members and log. */}
      <FilterBar onClearFilters={picked ? picker.clearDateRange : undefined}>
        <DateTimeRangePicker
          startDate={picker.startDate}
          endDate={picker.endDate}
          isDialogOpen={picker.isDateDialogOpen}
          tempStartDate={picker.tempStartDate}
          tempEndDate={picker.tempEndDate}
          displayText={rangeDisplay ?? `Last ${DEFAULT_DAYS} days`}
          onDialogOpenChange={picker.setIsDateDialogOpen}
          onTempStartDateChange={picker.setTempStartDate}
          onTempEndDateChange={picker.setTempEndDate}
          onOpenDialog={picker.openDateDialog}
          onApply={picker.handleApplyDateRange}
          className={filterControlClass({ active: picked })}
        />
      </FilterBar>
      <ErrorBoundary>
        <AgentAdoptionOverview window={window} />
      </ErrorBoundary>
      <section aria-labelledby="connection-log" className="space-y-3">
        <div className="space-y-1">
          <h2 id="connection-log" className="text-sm font-semibold">
            Connection log
          </h2>
          <p className="text-xs text-muted-foreground">
            Each setup downloaded from the Connect page, and each disconnect.
          </p>
        </div>
        <ErrorBoundary>
          <ConnectionLogTable window={window} />
        </ErrorBoundary>
      </section>
    </div>
  );
}

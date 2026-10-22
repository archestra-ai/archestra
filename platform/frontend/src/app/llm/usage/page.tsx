"use client";

import type { StatisticsTimeFrame } from "@archestra/shared";
import { PageLayout } from "@/components/page-layout";
import { useStatisticsTimeRange } from "@/components/time-range-picker/statistics-time-range";
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyStatistics, useMyUsageBreakdown } from "@/lib/statistics.query";
import { UsageContent } from "./usage-content";

const TIMEFRAME_STORAGE_KEY = "my-usage-timeframe";
const DEFAULT_TIMEFRAME: StatisticsTimeFrame = "7d";

export default function MyUsagePage() {
  // Queries wait until the range is read from the URL or this browser.
  const {
    range,
    setRange,
    timeframe,
    isResolved: isTimeframeResolved,
  } = useStatisticsTimeRange({
    storageKey: TIMEFRAME_STORAGE_KEY,
    defaultTimeframe: DEFAULT_TIMEFRAME,
  });

  const statisticsQuery = useMyStatistics({
    timeframe,
    enabled: isTimeframeResolved,
  });
  const breakdownQuery = useMyUsageBreakdown({
    timeframe,
    enabled: isTimeframeResolved,
  });

  return (
    <PageLayout
      minWidth="phone"
      title="My Usage"
      description="Review your own LLM activity, token mix, clients, models, sessions, and billed spend."
      actionButton={
        <TimeRangePicker value={range} onChange={setRange} allowAllTime />
      }
    >
      <div className="min-w-0 space-y-6">
        {statisticsQuery.isPending || breakdownQuery.isPending ? (
          <div className="grid min-w-0 gap-6 xl:grid-cols-2">
            <Skeleton className="h-72 w-full" />
            <Skeleton className="h-72 w-full" />
            <Skeleton className="h-72 w-full" />
            <Skeleton className="h-72 w-full" />
          </div>
        ) : statisticsQuery.isLoadingError || !statisticsQuery.data ? (
          <p className="text-muted-foreground py-8 text-center">
            Your model usage could not be loaded.
          </p>
        ) : breakdownQuery.isLoadingError || !breakdownQuery.data ? (
          <p className="text-muted-foreground py-8 text-center">
            Your usage breakdown could not be loaded.
          </p>
        ) : (
          <UsageContent
            statistics={statisticsQuery.data}
            breakdown={breakdownQuery.data}
            timeframe={timeframe}
          />
        )}
      </div>
    </PageLayout>
  );
}

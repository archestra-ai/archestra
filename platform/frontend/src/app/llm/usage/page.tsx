"use client";

import {
  type StatisticsTimeFrame,
  StatisticsTimeFrameSchema,
} from "@archestra/shared";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ContextSizeCard } from "@/app/llm/usage/_parts/context-size-card";
import { TokenMixCard } from "@/app/llm/usage/_parts/token-mix-card";
import { TopSessionsCard } from "@/app/llm/usage/_parts/top-sessions-card";
import {
  ClientUsageCard,
  ModelUsageCard,
} from "@/app/llm/usage/_parts/usage-dimension-cards";
import { MyUsageSummary } from "@/components/my-usage-summary";
import { PageLayout } from "@/components/page-layout";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyStatistics, useMyUsageBreakdown } from "@/lib/statistics.query";

const TIMEFRAMES = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "12m", label: "Last 12 months" },
  { value: "all", label: "All time" },
] as const satisfies readonly { value: StatisticsTimeFrame; label: string }[];

const TIMEFRAME_STORAGE_KEY = "my-usage-timeframe";
const DEFAULT_TIMEFRAME: StatisticsTimeFrame = "7d";

export default function MyUsagePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [timeframe, setTimeframe] =
    useState<StatisticsTimeFrame>(DEFAULT_TIMEFRAME);
  const [isTimeframeResolved, setIsTimeframeResolved] = useState(false);

  useEffect(() => {
    const { success, data } = StatisticsTimeFrameSchema.safeParse(
      searchParams.get("timeframe") ??
        localStorage.getItem(TIMEFRAME_STORAGE_KEY),
    );
    if (success) setTimeframe(data);
    setIsTimeframeResolved(true);
  }, [searchParams]);

  const handleTimeframeChange = useCallback(
    (value: string) => {
      const { success, data } = StatisticsTimeFrameSchema.safeParse(value);
      if (!success) return;
      setTimeframe(data);
      localStorage.setItem(TIMEFRAME_STORAGE_KEY, data);
      const params = new URLSearchParams(searchParams);
      params.set("timeframe", data);
      router.push(`/llm/usage?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

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
        <Select value={timeframe} onValueChange={handleTimeframeChange}>
          <SelectTrigger className="w-48" aria-label="Timeframe">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMEFRAMES.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      <div className="min-w-0 space-y-6">
        <MyUsageSummary timeframe={timeframe} enabled={isTimeframeResolved} />

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
          <>
            <div className="grid min-w-0 gap-6 xl:grid-cols-2">
              <ModelUsageCard models={statisticsQuery.data.models} />
              <ClientUsageCard clients={breakdownQuery.data.clients} />
            </div>

            <div className="grid min-w-0 gap-6 xl:grid-cols-2">
              <TokenMixCard mix={breakdownQuery.data.tokenMix} />
              <ContextSizeCard buckets={breakdownQuery.data.contextBuckets} />
            </div>

            <TopSessionsCard
              sessions={breakdownQuery.data.topSessions}
              totalCost={breakdownQuery.data.totalCost}
              unsessionedRequests={breakdownQuery.data.unsessionedRequests}
            />
          </>
        )}
      </div>
    </PageLayout>
  );
}

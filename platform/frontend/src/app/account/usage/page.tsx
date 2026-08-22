"use client";

import {
  type StatisticsTimeFrame,
  StatisticsTimeFrameSchema,
} from "@archestra/shared";
import { useEffect, useState } from "react";
import { ContextSizeCard } from "@/app/account/usage/_parts/context-size-card";
import { TokenMixCard } from "@/app/account/usage/_parts/token-mix-card";
import { TopSessionsCard } from "@/app/account/usage/_parts/top-sessions-card";
import { MyUsageSummary } from "@/components/my-usage-summary";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyUsageBreakdown } from "@/lib/statistics.query";

/**
 * Deliberately shorter than the Costs page's list, which starts at 5 minutes.
 * "What have I been spending on" is a question about days and weeks; a
 * five-minute window cannot answer it, and offering one invites a reading of
 * this page as a live meter rather than a review.
 */
const TIMEFRAMES = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
] as const satisfies readonly { value: StatisticsTimeFrame; label: string }[];

const TIMEFRAME_STORAGE_KEY = "my-usage-timeframe";
const DEFAULT_TIMEFRAME: StatisticsTimeFrame = "7d";

/**
 * Personal Settings > Usage: what the signed-in user's own AI usage was made
 * of.
 *
 * Lives here rather than on the Costs page because it reports on a person, not
 * on the organization, and because the diagnostic cuts need more room than a
 * summary card at the head of someone else's page. The Costs page keeps the
 * summary and links here.
 */
export default function AccountUsagePage() {
  const [timeframe, setTimeframe] =
    useState<StatisticsTimeFrame>(DEFAULT_TIMEFRAME);
  // localStorage is only readable after mount, so the queries wait rather than
  // firing one round at the default and a second at the stored value.
  const [isTimeframeResolved, setIsTimeframeResolved] = useState(false);

  useEffect(() => {
    const { success, data } = StatisticsTimeFrameSchema.safeParse(
      localStorage.getItem(TIMEFRAME_STORAGE_KEY),
    );
    if (success) setTimeframe(data);
    setIsTimeframeResolved(true);
  }, []);

  const handleTimeframeChange = (value: string) => {
    const { success, data } = StatisticsTimeFrameSchema.safeParse(value);
    if (!success) return;
    setTimeframe(data);
    localStorage.setItem(TIMEFRAME_STORAGE_KEY, data);
  };

  const {
    data: breakdown,
    isPending,
    isLoadingError,
  } = useMyUsageBreakdown({ timeframe, enabled: isTimeframeResolved });

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
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
      </div>

      <MyUsageSummary timeframe={timeframe} enabled={isTimeframeResolved} />

      {isPending ? (
        <div className="space-y-6">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isLoadingError || !breakdown ? (
        // Told apart from a quiet timeframe on purpose: reporting an outage as
        // "no activity" is the more expensive mistake on a page whose whole job
        // is to account for spend.
        <p className="text-muted-foreground py-6 text-center">
          Your usage breakdown could not be loaded.
        </p>
      ) : (
        <>
          <TokenMixCard mix={breakdown.tokenMix} />
          <ContextSizeCard buckets={breakdown.contextBuckets} />
          <TopSessionsCard
            sessions={breakdown.topSessions}
            totalCost={breakdown.totalCost}
            unsessionedRequests={breakdown.unsessionedRequests}
          />
        </>
      )}
    </div>
  );
}

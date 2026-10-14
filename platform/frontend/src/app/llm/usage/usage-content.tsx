"use client";
import { MyUsageSummary } from "@/components/my-usage-summary";
import { ContextSizeCard } from "./_parts/context-size-card";
import { TokenMixCard } from "./_parts/token-mix-card";
import { TopSessionsCard } from "./_parts/top-sessions-card";
import {
  ClientUsageCard,
  ModelUsageCard,
} from "./_parts/usage-dimension-cards";
import type { UsageViewProps } from "./usage-data";
import { UsageOverview } from "./usage-overview";

export function UsageContent(props: UsageViewProps) {
  const { statistics, breakdown, timeframe } = props;
  return (
    <div className="min-w-0 space-y-4">
      <UsageOverview statistics={statistics} />
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Spend over time
        </summary>
        <div className="pt-3">
          <MyUsageSummary timeframe={timeframe} />
        </div>
      </details>
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <ModelUsageCard models={statistics.models} />
        <ClientUsageCard clients={breakdown.clients} />
      </div>
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <TokenMixCard mix={breakdown.tokenMix} />
        <ContextSizeCard buckets={breakdown.contextBuckets} />
      </div>
      <TopSessionsCard
        sessions={breakdown.topSessions}
        totalCost={breakdown.totalCost}
        unsessionedRequests={breakdown.unsessionedRequests}
      />
    </div>
  );
}

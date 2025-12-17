import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
  type StatisticsTimeFrame,
  StatisticsTimeFrameSchema,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import { StatisticsPageClient } from "./page.client";

export const dynamic = "force-dynamic";

export type StatisticsInitialData = {
  teamStatistics: archestraApiTypes.GetTeamStatisticsResponses["200"];
  agentStatistics: archestraApiTypes.GetAgentStatisticsResponses["200"];
  modelStatistics: archestraApiTypes.GetModelStatisticsResponses["200"];
  costSavingsStatistics: archestraApiTypes.GetCostSavingsStatisticsResponses["200"];
  timeframe: StatisticsTimeFrame;
};

const DEFAULT_TIMEFRAME: StatisticsTimeFrame = "1h";

const DEFAULT_COST_SAVINGS: StatisticsInitialData["costSavingsStatistics"] = {
  totalBaselineCost: 0,
  totalActualCost: 0,
  totalSavings: 0,
  totalOptimizationSavings: 0,
  totalToonSavings: 0,
  timeSeries: [],
};

export default async function StatisticsPage({
  searchParams,
}: {
  searchParams: Promise<{ timeframe?: string }>;
}) {
  // Parse timeframe from URL with validation
  const params = await searchParams;
  const parseResult = StatisticsTimeFrameSchema.safeParse(params.timeframe);
  const timeframe: StatisticsTimeFrame = parseResult.success
    ? parseResult.data
    : DEFAULT_TIMEFRAME;

  // For custom timeframes, use "all" for the API call
  const apiTimeframe = timeframe.startsWith("custom:") ? "all" : timeframe;

  let initialData: StatisticsInitialData = {
    teamStatistics: [],
    agentStatistics: [],
    modelStatistics: [],
    costSavingsStatistics: DEFAULT_COST_SAVINGS,
    timeframe,
  };

  try {
    const headers = await getServerApiHeaders();

    // Use Promise.allSettled for graceful fallback if individual APIs fail
    const [
      teamStatisticsResult,
      agentStatisticsResult,
      modelStatisticsResult,
      costSavingsResult,
    ] = await Promise.allSettled([
      archestraApiSdk.getTeamStatistics({
        headers,
        query: { timeframe: apiTimeframe },
      }),
      archestraApiSdk.getAgentStatistics({
        headers,
        query: { timeframe: apiTimeframe },
      }),
      archestraApiSdk.getModelStatistics({
        headers,
        query: { timeframe: apiTimeframe },
      }),
      archestraApiSdk.getCostSavingsStatistics({
        headers,
        query: { timeframe: apiTimeframe },
      }),
    ]);

    initialData = {
      teamStatistics:
        teamStatisticsResult.status === "fulfilled"
          ? teamStatisticsResult.value.data || []
          : [],
      agentStatistics:
        agentStatisticsResult.status === "fulfilled"
          ? agentStatisticsResult.value.data || []
          : [],
      modelStatistics:
        modelStatisticsResult.status === "fulfilled"
          ? modelStatisticsResult.value.data || []
          : [],
      costSavingsStatistics:
        costSavingsResult.status === "fulfilled"
          ? costSavingsResult.value.data || DEFAULT_COST_SAVINGS
          : DEFAULT_COST_SAVINGS,
      timeframe,
    };

    // Log any failed requests for debugging
    const failedRequests = [
      { name: "teamStatistics", result: teamStatisticsResult },
      { name: "agentStatistics", result: agentStatisticsResult },
      { name: "modelStatistics", result: modelStatisticsResult },
      { name: "costSavings", result: costSavingsResult },
    ].filter((r) => r.result.status === "rejected");

    if (failedRequests.length > 0) {
      console.warn(
        "Some statistics requests failed:",
        failedRequests.map((r) => ({
          name: r.name,
          error:
            r.result.status === "rejected" ? r.result.reason : "unknown error",
        })),
      );
    }
  } catch (error) {
    console.error("Error fetching statistics:", error);
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <StatisticsPageClient initialData={initialData} />;
}

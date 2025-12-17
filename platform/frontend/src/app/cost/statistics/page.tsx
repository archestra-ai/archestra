import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
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
};

const DEFAULT_TIMEFRAME = "1h" as const;

export default async function StatisticsPage() {
  let initialData: StatisticsInitialData = {
    teamStatistics: [],
    agentStatistics: [],
    modelStatistics: [],
    costSavingsStatistics: {
      totalBaselineCost: 0,
      totalActualCost: 0,
      totalSavings: 0,
      totalOptimizationSavings: 0,
      totalToonSavings: 0,
      timeSeries: [],
    },
  };

  try {
    const headers = await getServerApiHeaders();

    const [
      teamStatisticsResponse,
      agentStatisticsResponse,
      modelStatisticsResponse,
      costSavingsResponse,
    ] = await Promise.all([
      archestraApiSdk.getTeamStatistics({
        headers,
        query: { timeframe: DEFAULT_TIMEFRAME },
      }),
      archestraApiSdk.getAgentStatistics({
        headers,
        query: { timeframe: DEFAULT_TIMEFRAME },
      }),
      archestraApiSdk.getModelStatistics({
        headers,
        query: { timeframe: DEFAULT_TIMEFRAME },
      }),
      archestraApiSdk.getCostSavingsStatistics({
        headers,
        query: { timeframe: DEFAULT_TIMEFRAME },
      }),
    ]);

    initialData = {
      teamStatistics: teamStatisticsResponse.data || [],
      agentStatistics: agentStatisticsResponse.data || [],
      modelStatistics: modelStatisticsResponse.data || [],
      costSavingsStatistics:
        costSavingsResponse.data || initialData.costSavingsStatistics,
    };
  } catch (error) {
    console.error("Error fetching statistics:", error);
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <StatisticsPageClient initialData={initialData} />;
}

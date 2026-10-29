import type { archestraApiTypes, StatisticsTimeFrame } from "@archestra/shared";

export type UsageViewProps = {
  statistics: archestraApiTypes.GetMyStatisticsResponses["200"];
  breakdown: archestraApiTypes.GetMyUsageBreakdownResponses["200"];
  timeframe: StatisticsTimeFrame;
};

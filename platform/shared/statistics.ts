import { z } from "zod";

export const StatisticsTimeFrameSchema = z.union([
  z.enum(["5m", "15m", "30m", "1h", "24h", "7d", "30d", "90d", "12m", "all"]),
  z
    .templateLiteral(["custom:", z.string(), "_", z.string()])
    .describe("Custom timeframe must be in format 'custom:startTime_endTime'"),
]);

export type StatisticsTimeFrame = z.infer<typeof StatisticsTimeFrameSchema>;

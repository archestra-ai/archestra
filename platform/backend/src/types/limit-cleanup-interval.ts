import { z } from "zod";

export const LimitCleanupIntervalSchema = z
  .enum(["1h", "12h", "24h", "1w", "1m"])
  .nullable();

export type LimitCleanupInterval = z.infer<typeof LimitCleanupIntervalSchema>;

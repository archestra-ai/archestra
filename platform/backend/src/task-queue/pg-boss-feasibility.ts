import {
  type QueueCapability,
  TASK_QUEUE_CAPABILITY_MATRIX,
} from "./capabilities";

export type FeasibilityReport = {
  isViableReplacement: boolean;
  blockingGaps: QueueCapability[];
  nonBlockingGaps: QueueCapability[];
  supportedCount: number;
  partialCount: number;
  unsupportedCount: number;
};

export function analyzePgBossFeasibility(
  matrix: QueueCapability[] = TASK_QUEUE_CAPABILITY_MATRIX,
): FeasibilityReport {
  const supportedCount = matrix.filter((item) => item.pgBoss === "supported").length;
  const partial = matrix.filter((item) => item.pgBoss === "partial");
  const unsupported = matrix.filter((item) => item.pgBoss === "unsupported");

  const blockingGaps = [...partial, ...unsupported].filter(
    (item) => item.required,
  );

  const nonBlockingGaps = [...partial, ...unsupported].filter(
    (item) => !item.required,
  );

  return {
    isViableReplacement: blockingGaps.length === 0,
    blockingGaps,
    nonBlockingGaps,
    supportedCount,
    partialCount: partial.length,
    unsupportedCount: unsupported.length,
  };
}

export const PG_BOSS_FEASIBILITY_REPORT = analyzePgBossFeasibility();

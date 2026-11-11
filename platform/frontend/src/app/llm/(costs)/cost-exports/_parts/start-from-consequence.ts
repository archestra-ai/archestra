import type { CostExportSchedule } from "@archestra/shared";

/** What a start means for the files written: the backfill, then the cadence. */
export function startFromConsequence({
  start,
  schedule,
  now = new Date(),
}: {
  start: Date | null;
  schedule: CostExportSchedule;
  now?: Date;
}): string {
  const unit = schedule === "hourly" ? "hour" : "day";
  const count = start ? backfillFileCount({ start, schedule, now }) : 0;
  if (count === 0) {
    return `The first file is written once this ${unit} ends, then one per ${unit}.`;
  }
  const files = `${count.toLocaleString("en-US")} ${schedule} ${count === 1 ? "file" : "files"}`;
  return `Writes about ${files} now, then one per ${unit}.`;
}

// === internal ===

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Completed periods from the start's period up to the one in progress: the
 * files a backfill writes right away. Periods are UTC days or hours.
 */
function backfillFileCount({
  start,
  schedule,
  now,
}: {
  start: Date;
  schedule: CostExportSchedule;
  now: Date;
}): number {
  const period = schedule === "hourly" ? HOUR_MS : DAY_MS;
  return Math.max(
    0,
    Math.floor(now.getTime() / period) - Math.floor(start.getTime() / period),
  );
}

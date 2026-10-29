import { randomUUID } from "node:crypto";
import type { LimitCleanupInterval } from "@/types/limit";

export type ThroughputBucket = {
  version: 2;
  generation: string;
  count: number;
  released: number;
  updatedAt: number;
  rate: number;
  interval?: LimitCleanupInterval;
  epoch?: string;
  periodEnd?: number;
};

/**
 * Attribute every reduction since admission to this receipt first. The result
 * is a conservative lower bound on its remaining charge, so a late refund
 * cannot release allowance occupied by another request. No per-request queue
 * grows inside the shared counter.
 */
export function refundableCharge(params: {
  bucket: ThroughputBucket;
  generation: string;
  released: number;
  amount: number;
}): number {
  if (params.bucket.generation !== params.generation) return 0;
  return Math.min(
    params.bucket.count,
    Math.max(0, params.amount - (params.bucket.released - params.released)),
  );
}

export function readBucket(params: {
  raw?: string;
  now: number;
  capacity: number;
  interval?: LimitCleanupInterval;
  epoch?: string;
  anchor?: number;
}): ThroughputBucket {
  const interval = params.interval ?? "minute";
  const fresh = () => ({
    ...emptyBucket(params.now, params.capacity),
    interval,
    epoch: params.epoch,
    ...(interval === "minute"
      ? {}
      : {
          periodEnd: periodEnd({
            now: params.now,
            anchor: params.anchor ?? params.now,
            interval,
          }),
        }),
  });
  if (!params.raw) return fresh();
  const value = JSON.parse(params.raw).value;
  // Preserve still-live dev fixed-window debt during this unshipped revision.
  // Expired old counters have already recovered under their original contract.
  if (value?.version === undefined && Number.isSafeInteger(value?.window)) {
    if (
      value.window % 60000 !== 0 ||
      !Number.isSafeInteger(value.count) ||
      value.count < 0
    )
      throw new Error("Invalid shared throughput counter");
    return {
      ...fresh(),
      count: params.now < value.window + 60000 ? value.count : 0,
    };
  }
  if (
    value?.version !== 2 ||
    typeof value.generation !== "string" ||
    ![value.count, value.released, value.updatedAt, value.rate].every(
      (number) =>
        Number.isFinite(number) &&
        number >= 0 &&
        number <= Number.MAX_SAFE_INTEGER,
    ) ||
    value.rate <= 0
  )
    throw new Error("Invalid shared throughput counter");
  if (
    (value.interval ?? "minute") !== interval ||
    (value.interval !== undefined && value.epoch !== params.epoch)
  )
    return fresh();
  if (interval !== "minute") {
    if (!Number.isFinite(value.periodEnd))
      throw new Error("Invalid shared quota period");
    if (params.now >= value.periodEnd) return fresh();
    return {
      ...value,
      updatedAt: Math.max(params.now, value.updatedAt),
      rate: params.capacity,
    };
  }
  const drained = drainBucket({ ...params, bucket: value });
  return { ...drained, interval, epoch: params.epoch };
}

/** UTC calendar boundaries; rolling periods start when created/reset, not on a wall-clock boundary. */
function periodEnd(params: {
  now: number;
  anchor: number;
  interval: LimitCleanupInterval;
}): number {
  const { now, anchor, interval } = params;
  const rolling = {
    "1h": 3600000,
    "12h": 43200000,
    "24h": 86400000,
    "1w": 604800000,
  };
  const duration = rolling[interval as keyof typeof rolling];
  if (duration) return (anchor + duration > now ? anchor : now) + duration;
  if (interval === "1m") {
    const end = addMonth(anchor);
    return end > now ? end : addMonth(now);
  }
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  if (interval === "calendar_month") {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
  } else if (interval === "calendar_day")
    date.setUTCDate(date.getUTCDate() + 1);
  else {
    const start = interval === "calendar_week_monday" ? 1 : 0;
    date.setUTCDate(
      date.getUTCDate() + 7 - ((date.getUTCDay() - start + 7) % 7),
    );
  }
  return date.getTime();
}

function addMonth(at: number): number {
  const date = new Date(at);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const last = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime();
}

/** Drain at the previously observed rate; a cap edit changes only future drain. */
function drainBucket(params: {
  bucket?: ThroughputBucket;
  now: number;
  capacity: number;
}): ThroughputBucket {
  const { bucket, now, capacity } = params;
  if (!bucket) return emptyBucket(now, capacity);
  const at = Math.max(now, bucket.updatedAt);
  const drained = Math.min(
    bucket.count,
    ((at - bucket.updatedAt) * bucket.rate) / 60000,
  );
  if (drained >= bucket.count) return emptyBucket(at, capacity);
  return {
    ...bucket,
    count: bucket.count - drained,
    released: bucket.released + drained,
    updatedAt: at,
    rate: capacity,
  };
}

function emptyBucket(now: number, capacity: number): ThroughputBucket {
  return {
    version: 2,
    generation: randomUUID(),
    count: 0,
    released: 0,
    updatedAt: now,
    rate: capacity,
  };
}

import { describe, expect, test } from "vitest";
import {
  readBucket,
  refundableCharge,
  type ThroughputBucket,
} from "./throughput-bucket";

describe("continuous rate allowance", () => {
  test.each([
    0, 1, 2, 3, 4, 5, 6,
  ])("calendar weeks retain debt on weekday %i until the next boundary", (weekday) => {
    for (const [interval, start] of [
      ["calendar_week_sunday", 0],
      ["calendar_week_monday", 1],
    ] as const) {
      const now = Date.UTC(2026, 1, 1 + weekday, 12);
      const daysAhead = (start - weekday + 7) % 7 || 7;
      const expected = Date.UTC(2026, 1, 1 + weekday + daysAhead);
      const bucket = {
        ...readBucket({ now, capacity: 10, interval }),
        count: 10,
      };
      expect(bucket.periodEnd).toBe(expected);
      expect(expected).toBeGreaterThan(now);
      const raw = JSON.stringify({ value: bucket });
      expect(
        readBucket({ raw, now: now + 60000, capacity: 10, interval }).count,
      ).toBe(10);
      expect(
        readBucket({ raw, now: expected, capacity: 10, interval }).count,
      ).toBe(0);
    }
  });

  test("uses exact UTC calendar and month-clamped rolling boundaries without draining period counters", () => {
    const now = Date.parse("2026-01-31T12:30:00Z");
    for (const [interval, expected] of [
      ["calendar_day", "2026-02-01T00:00:00Z"],
      ["calendar_month", "2026-02-01T00:00:00Z"],
      ["calendar_week_sunday", "2026-02-01T00:00:00Z"],
      ["calendar_week_monday", "2026-02-02T00:00:00Z"],
      ["1m", "2026-02-28T12:30:00Z"],
    ] as const) {
      const bucket = {
        ...readBucket({ now, capacity: 100, interval }),
        count: 80,
      };
      expect(bucket.periodEnd).toBe(Date.parse(expected));
      expect(
        readBucket({
          raw: JSON.stringify({ value: bucket }),
          now: now + 60000,
          capacity: 100,
          interval,
        }).count,
      ).toBe(80);
      expect(
        readBucket({
          raw: JSON.stringify({ value: bucket }),
          now: Date.parse(expected),
          capacity: 100,
          interval,
        }).count,
      ).toBe(0);
    }
  });
  test("drains fractional requests across a wall minute without resetting", () => {
    const bucket = {
      ...drainBucket({ now: 59990, capacity: 3 }),
      count: 3,
    };
    const after = drainBucket({ bucket, now: 60010, capacity: 3 });
    expect(after.count).toBeCloseTo(2.999, 9);
    expect(after.generation).toBe(bucket.generation);
    expect(drainBucket({ bucket, now: 79990, capacity: 3 }).count).toBe(2);
  });

  test("uses old drain rate until a cap change and never drains backwards", () => {
    const bucket = { ...drainBucket({ now: 1000, capacity: 60 }), count: 60 };
    const changed = drainBucket({ bucket, now: 11000, capacity: 120 });
    expect(changed.count).toBe(50);
    expect(
      drainBucket({ bucket: changed, now: 12000, capacity: 120 }).count,
    ).toBe(48);
    const backwards = drainBucket({
      bucket: changed,
      now: 9000,
      capacity: 120,
    });
    expect(backwards.count).toBe(50);
    expect(backwards.updatedAt).toBe(11000);
  });

  test("never refunds later work after the original charge could have drained", () => {
    const bucket = { ...drainBucket({ now: 1000, capacity: 600 }), count: 100 };
    const receipt = { generation: bucket.generation, released: 0, amount: 100 };
    // Newer work keeps the bucket nonempty while the old charge drains.
    bucket.count += 300;
    const later = drainBucket({ bucket, now: 16000, capacity: 600 });
    expect(later.count).toBe(250);
    expect(refundableCharge({ bucket: later, ...receipt })).toBe(0);
  });

  test("caps refunds to surviving charge and accounts for other refunds", () => {
    const bucket = { ...drainBucket({ now: 1000, capacity: 600 }), count: 400 };
    const receipt = { generation: bucket.generation, released: 0, amount: 100 };
    const later = drainBucket({ bucket, now: 4000, capacity: 600 });
    expect(refundableCharge({ bucket: later, ...receipt })).toBe(70);
    later.count -= 60;
    later.released += 60;
    expect(refundableCharge({ bucket: later, ...receipt })).toBe(10);
    const recovered = drainBucket({ bucket: later, now: 61000, capacity: 600 });
    recovered.count = 500;
    expect(refundableCharge({ bucket: recovered, ...receipt })).toBe(0);
  });

  test("preserves live legacy debt, rejects corrupt state, and expires old windows", () => {
    const raw = JSON.stringify({ value: { window: 60000, count: 5 } });
    expect(readBucket({ raw, now: 70000, capacity: 10 }).count).toBe(5);
    expect(readBucket({ raw, now: 120000, capacity: 10 }).count).toBe(0);
    expect(() =>
      readBucket({
        raw: '{"value":{"window":0,"count":null}}',
        now: 100,
        capacity: 10,
      }),
    ).toThrow("Invalid shared throughput counter");
  });
});

function drainBucket(params: {
  bucket?: ThroughputBucket;
  now: number;
  capacity: number;
}) {
  return readBucket({
    now: params.now,
    capacity: params.capacity,
    raw: params.bucket ? JSON.stringify({ value: params.bucket }) : undefined,
  });
}

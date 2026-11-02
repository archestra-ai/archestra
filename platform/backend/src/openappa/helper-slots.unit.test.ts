import { describe, expect, test } from "vitest";
import { HelperSlots } from "./helper-slots";

describe("HelperSlots", () => {
  test("a consult over the cap waits for a running one to end and takes its slot", async () => {
    const slots = new HelperSlots(() => 1);
    expect(await slots.acquire(Date.now())).toBe(true);
    const waiting = slots.acquire(Date.now() + 5_000);
    slots.release();
    expect(await waiting).toBe(true);
    // The handed-over slot is still taken: a third consult with no time to wait is turned away.
    expect(await slots.acquire(Date.now())).toBe(false);
    slots.release();
    expect(await slots.acquire(Date.now())).toBe(true);
  });

  test("a consult whose wait runs out is turned away and leaves no claim on a later slot", async () => {
    const slots = new HelperSlots(() => 1);
    await slots.acquire(Date.now());
    const startedAt = Date.now();
    expect(await slots.acquire(startedAt + 30)).toBe(false);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
    slots.release();
    expect(await slots.acquire(Date.now())).toBe(true);
  });

  test("waiting consults take freed slots oldest first", async () => {
    const slots = new HelperSlots(() => 1);
    await slots.acquire(Date.now());
    const order: string[] = [];
    const first = slots
      .acquire(Date.now() + 5_000)
      .then(() => order.push("first"));
    const second = slots
      .acquire(Date.now() + 5_000)
      .then(() => order.push("second"));
    slots.release();
    await first;
    slots.release();
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  test("a lowered cap is honoured: a freed slot above it is not handed over", async () => {
    let cap = 2;
    const slots = new HelperSlots(() => cap);
    await slots.acquire(Date.now());
    await slots.acquire(Date.now());
    cap = 1;
    const waiting = slots.acquire(Date.now() + 50);
    slots.release();
    expect(await waiting).toBe(false);
  });
});

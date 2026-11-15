import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { type AllowedCacheKey, CacheKey } from "@/cache-manager";
import { setupTestCacheManager } from "@/test/cache-manager";
import { withOpenAppaLease } from "./openappa-leases";

setupTestCacheManager();

/**
 * Work that runs until the test lets it end. `started` settles when the work
 * begins. A test waits for that or for the call to settle without running it,
 * never for a deadline: a claim on a loaded runner can take over a second.
 */
function heldWork<T>(value: T) {
  const state = { started: false, end: () => {} };
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const work = async () => {
    state.started = true;
    markStarted();
    await new Promise<void>((resolve) => {
      state.end = resolve;
    });
    return value;
  };
  return { state, started, work };
}

test("a holder whose work outlives its lease ends only its own: the caller that took the lease over keeps it", async () => {
  const key: AllowedCacheKey = `${CacheKey.OpenAppaPolicyCheck}-lease-test-${randomUUID()}`;
  const firstHolder = heldWork("first");
  const first = withOpenAppaLease({ key, ttlMs: 50, work: firstHolder.work });
  await Promise.race([firstHolder.started, first]);
  expect(firstHolder.state.started).toBe(true);
  // The first holder's lease lapses while its work still runs, and the next
  // caller takes it over.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const secondHolder = heldWork("second");
  const second = withOpenAppaLease({
    key,
    ttlMs: 60_000,
    work: secondHolder.work,
  });
  await Promise.race([secondHolder.started, second]);
  expect(secondHolder.state.started).toBe(true);
  firstHolder.state.end();
  expect(await first).toEqual({ ran: true, value: "first" });

  // The first holder has ended, and the second still holds the lease.
  expect(
    await withOpenAppaLease({ key, ttlMs: 60_000, work: async () => "third" }),
  ).toEqual({ ran: false });
  secondHolder.state.end();
  expect(await second).toEqual({ ran: true, value: "second" });
  expect(
    await withOpenAppaLease({ key, ttlMs: 60_000, work: async () => "fourth" }),
  ).toEqual({ ran: true, value: "fourth" });
});

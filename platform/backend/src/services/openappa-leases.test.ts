import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { type AllowedCacheKey, CacheKey } from "@/cache-manager";
import { setupTestCacheManager } from "@/test/cache-manager";
import { withOpenAppaLease } from "./openappa-leases";

setupTestCacheManager();

/** Work that runs until the test lets it end. */
function heldWork<T>(value: T) {
  const state = { started: false, end: () => {} };
  const work = async () => {
    state.started = true;
    await new Promise<void>((resolve) => {
      state.end = resolve;
    });
    return value;
  };
  return { state, work };
}

test("a holder whose work outlives its lease ends only its own: the caller that took the lease over keeps it", async () => {
  const key: AllowedCacheKey = `${CacheKey.OpenAppaPolicyCheck}-lease-test-${randomUUID()}`;
  const firstHolder = heldWork("first");
  const first = withOpenAppaLease({ key, ttlMs: 50, work: firstHolder.work });
  await vi.waitFor(() => expect(firstHolder.state.started).toBe(true));
  // The first holder's lease lapses while its work still runs, and the next
  // caller takes it over.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const secondHolder = heldWork("second");
  const second = withOpenAppaLease({
    key,
    ttlMs: 60_000,
    work: secondHolder.work,
  });
  await vi.waitFor(() => expect(secondHolder.state.started).toBe(true));
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

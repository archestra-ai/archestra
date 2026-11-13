import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { type AllowedCacheKey, CacheKey } from "@/cache-manager";
import { setupTestCacheManager } from "@/test/cache-manager";
import { withOpenAppaLease } from "./openappa-leases";

setupTestCacheManager();

test("a holder whose work outlives its lease ends only its own: the caller that took the lease over keeps it", async () => {
  const key: AllowedCacheKey = `${CacheKey.OpenAppaPolicyCheck}-lease-test-${randomUUID()}`;
  // The first holder's lease lapses while its work still runs.
  const first = withOpenAppaLease({
    key,
    ttlMs: 50,
    work: () =>
      new Promise((resolve) => setTimeout(() => resolve("first"), 400)),
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  let release = () => {};
  let secondStarted = false;
  const second = withOpenAppaLease({
    key,
    ttlMs: 60_000,
    work: async () => {
      secondStarted = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "second";
    },
  });
  await vi.waitFor(() => expect(secondStarted).toBe(true));
  expect(await first).toEqual({ ran: true, value: "first" });

  // The first holder has ended, and the second still holds the lease.
  expect(
    await withOpenAppaLease({ key, ttlMs: 60_000, work: async () => "third" }),
  ).toEqual({ ran: false });
  release();
  expect(await second).toEqual({ ran: true, value: "second" });
  expect(
    await withOpenAppaLease({ key, ttlMs: 60_000, work: async () => "fourth" }),
  ).toEqual({ ran: true, value: "fourth" });
});

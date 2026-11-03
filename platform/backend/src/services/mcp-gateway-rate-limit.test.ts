import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { RateLimiterRes } from "rate-limiter-flexible";
import { describe, expect, test, vi } from "vitest";
import { cacheManager } from "@/cache-manager";
import db from "@/database";
import { setupTestCacheManager } from "@/test/cache-manager";
import { McpGatewayRateLimiter } from "./mcp-gateway-rate-limit";

setupTestCacheManager();

describe("gateway attempt budgets", () => {
  test("admits only ten simultaneous attempts across replicas and resets at the original window end", async () => {
    const replicas = [new McpGatewayRateLimiter(), new McpGatewayRateLimiter()];
    const caller = { credential: randomUUID(), gateway: randomUUID() };
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const attempts = await Promise.allSettled(
        Array.from({ length: 16 }, (_, i) =>
          replicas[i % 2].consume("192.0.2.1", 1, caller),
        ),
      );
      expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(10);
      const denied = attempts.filter((r) => r.status === "rejected");
      expect(denied).toHaveLength(6);
      for (const result of denied) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(RateLimiterRes);
          expect(result.reason.msBeforeNext).toBe(60_000);
        }
      }
      clock.mockReturnValue(now + 59_000);
      await expect(
        replicas[0].consume("192.0.2.1", 1, caller),
      ).rejects.toMatchObject({
        msBeforeNext: 1_000,
      });
      clock.mockReturnValue(now + 60_001);
      await expect(
        replicas[1].consume("192.0.2.1", 1, caller),
      ).resolves.toMatchObject({
        consumedPoints: 1,
      });
    } finally {
      clock.mockRestore();
    }
  });

  test("caps rotating guesses without blocking validated pairs or persisting raw credentials", async () => {
    const first = new McpGatewayRateLimiter();
    const second = new McpGatewayRateLimiter();
    const caller = {
      credential: `Bearer ${randomUUID()}`,
      gateway: randomUUID(),
    };
    await first.consume("192.0.2.2", 1, caller);
    await first.recordSuccess(caller);
    // The successful first attempt consumed one slot; 99 guesses fill the IP.
    for (let i = 0; i < 99; i += 1) {
      await second.consume("192.0.2.2", 1, {
        ...caller,
        credential: randomUUID(),
      });
    }
    await expect(
      second.consume("192.0.2.2", 1, {
        ...caller,
        credential: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(RateLimiterRes);
    // Another replica recognizes the verified pair; normal traffic is unmetered.
    for (let i = 0; i < 20; i += 1) {
      await expect(
        second.consume("192.0.2.2", 1, caller),
      ).resolves.toMatchObject({ consumedPoints: 0 });
    }
    await expect(
      second.consume("192.0.2.2", 1, {
        ...caller,
        gateway: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(RateLimiterRes);
    // Losing authorization removes the exemption even on a previously warm replica.
    await second.recordDenial(caller);
    await expect(second.consume("192.0.2.2", 1, caller)).rejects.toBeInstanceOf(
      RateLimiterRes,
    );
    // A different origin has an independent budget.
    await expect(second.consume("192.0.2.3", 1, caller)).resolves.toMatchObject(
      { consumedPoints: 1 },
    );
    const rows = await db.execute(sql`SELECT key, value FROM keyv_cache`);
    expect(JSON.stringify(rows.rows)).not.toContain(caller.credential);
    // 100 pair buckets plus the IP and at most the second origin's two rows.
    expect(rows.rows.length).toBeLessThanOrEqual(104);
  });

  test("does not admit an unknown caller when shared storage is unavailable", async () => {
    cacheManager.shutdown();
    await expect(
      new McpGatewayRateLimiter().consume("192.0.2.4", 1, {
        credential: randomUUID(),
        gateway: randomUUID(),
      }),
    ).rejects.toThrow("Not started");
  });
  test("refreshes active clients across IP windows so a new guessing burst cannot lock them out", async () => {
    const limiter = new McpGatewayRateLimiter();
    const caller = { credential: randomUUID(), gateway: randomUUID() };
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await limiter.consume("192.0.2.5", 1, caller);
      await limiter.recordSuccess(caller);
      clock.mockReturnValue(now + 59_000);
      await limiter.consume("192.0.2.5", 1, caller);
      await limiter.recordSuccess(caller);
      clock.mockReturnValue(now + 60_001);
      for (let i = 0; i < 100; i += 1) {
        await limiter.consume("192.0.2.5", 1, {
          ...caller,
          credential: randomUUID(),
        });
      }
      await expect(
        limiter.consume("192.0.2.5", 1, caller),
      ).resolves.toMatchObject({ consumedPoints: 0 });
      await expect(
        new McpGatewayRateLimiter().consume("192.0.2.5", 1, caller),
      ).resolves.toMatchObject({ consumedPoints: 0 });
    } finally {
      clock.mockRestore();
    }
  });

  test.each([
    "not-deleted",
    "error",
  ])("does not reload a known-denied exemption when shared deletion fails (%s)", async (failure) => {
    const limiter = new McpGatewayRateLimiter();
    const caller = { credential: randomUUID(), gateway: randomUUID() };
    await limiter.consume("192.0.2.6", 1, caller);
    await limiter.recordSuccess(caller);
    for (let i = 0; i < 99; i += 1) {
      await limiter.consume("192.0.2.6", 1, {
        ...caller,
        credential: randomUUID(),
      });
    }
    // Leave the positive row intact, as a failed best-effort deletion does.
    const deletion = vi
      .spyOn(cacheManager, "delete")
      .mockImplementationOnce(async () => {
        if (failure === "error") throw new Error("Storage unavailable");
        return false;
      });
    try {
      await limiter.recordDenial(caller);
      await expect(
        limiter.consume("192.0.2.6", 1, caller),
      ).rejects.toBeInstanceOf(RateLimiterRes);
    } finally {
      deletion.mockRestore();
    }
  });
});
